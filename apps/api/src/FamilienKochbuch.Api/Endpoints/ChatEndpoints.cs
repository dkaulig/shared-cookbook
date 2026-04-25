using System.IdentityModel.Tokens.Jwt;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Ai;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// CR2 — native .NET chat surface. Rewritten from the P2-6 proxy
/// (<c>POST /api/chat</c> → Python <c>/chat</c>) into a session-aware,
/// SSE-streaming set of endpoints that persist history in our own DB
/// and call Azure OpenAI directly:
///
/// <list type="bullet">
/// <item><c>GET /api/chat/sessions</c> — caller's last 20 sessions,
/// newest-first.</item>
/// <item><c>POST /api/chat/sessions</c> — create empty session.</item>
/// <item><c>PATCH /api/chat/sessions/{id}</c> — rename.</item>
/// <item><c>DELETE /api/chat/sessions/{id}</c> — hard-delete (cascades
/// messages via the EF config).</item>
/// <item><c>GET /api/chat/sessions/{id}/messages</c> — message history
/// ordered by CreatedAt ASC, with <c>?before</c>/<c>?limit</c>
/// pagination.</item>
/// <item><c>POST /api/chat/sessions/{id}/turn</c> — <b>SSE stream</b>:
/// persists user message, streams assistant reply token-by-token, then
/// persists the assistant message + usage log.</item>
/// <item><c>POST /api/chat/sessions/{id}/to-recipe</c> — server-side
/// proxy to Python <c>/chat/{sid}/to-recipe</c>. The message list is
/// loaded from the DB (not trusted from the request body).</item>
/// </list>
///
/// Ownership check is centralised in
/// <see cref="LoadOwnedSessionAsync"/>: a session the caller doesn't
/// own returns 404, not 403, so the endpoint doesn't leak session
/// existence across tenants.
///
/// The old <c>POST /api/chat</c> route is deleted outright — the
/// frontend swap lands in CR4 and there is no production consumer to
/// keep backward-compatible.
/// </summary>
public static class ChatEndpoints
{
    /// <summary>CFG-3 — extractor-config key that gates
    /// <see cref="TurnAsync"/>. When the admin flips this to
    /// <c>false</c>, the handler returns 503 with the
    /// <c>feature_disabled</c> code before any DB write or Azure call.
    /// Seeded default is <c>true</c>.</summary>
    public const string FeatureFlagKey = "feature.chat_enabled";

    // ── DTOs ─────────────────────────────────────────────────────────

    /// <summary>Row shape returned by <c>GET /api/chat/sessions</c>.
    /// Frontend <c>ChatSessionListItem</c> maps 1:1.</summary>
    public sealed record ChatSessionListItemDto(
        Guid Id,
        string? Title,
        int MessageCount,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    /// <summary>Row shape returned by <c>GET /api/chat/sessions/{id}/messages</c>.</summary>
    public sealed record ChatMessageDto(
        Guid Id,
        string Role,
        string Content,
        DateTimeOffset CreatedAt);

    /// <summary>Body of <c>POST /api/chat/sessions</c>.</summary>
    public sealed record CreateSessionResponse(Guid SessionId);

    /// <summary>Body of <c>PATCH /api/chat/sessions/{id}</c>.</summary>
    public sealed record RenameSessionRequest(string Title);

    /// <summary>Body of <c>POST /api/chat/sessions/{id}/turn</c>.</summary>
    public sealed record TurnRequest(string Content);

    // ── Constants ────────────────────────────────────────────────────

    /// <summary>Maximum length of a user-supplied turn message. Matches
    /// the domain's <see cref="ChatMessage.ContentMaxLength"/> divided
    /// by 4 — a single user prompt should be a paragraph at most, not
    /// an entire transcript.</summary>
    public const int TurnContentMaxLength = 8 * 1024;

    /// <summary>Hard cap on <c>?limit</c> for message-history GETs.</summary>
    public const int MessagesMaxLimit = 500;

    /// <summary>Default page size for message-history GETs.</summary>
    public const int MessagesDefaultLimit = 200;

    /// <summary>Cap on the session list endpoint.</summary>
    public const int SessionListLimit = 20;

    /// <summary>Maximum history length sent to Azure on each turn.
    /// Older messages are dropped — keeps the prompt bounded and
    /// mirrors the Python-side 30-message safety cap.</summary>
    public const int MaxTurnsPerLlmCall = 30;

    /// <summary>Max message-content length for the to-recipe Python
    /// call. Each row is already capped by the domain; this is an
    /// extra safety net.</summary>
    public const int ToRecipeMessageMaxLength = 8000;

    /// <summary>Interval between SSE heartbeats while no tokens are
    /// flowing. Keeps intermediate proxies (Caddy/nginx) from closing
    /// the idle stream.</summary>
    public static readonly TimeSpan SseHeartbeatInterval = TimeSpan.FromSeconds(15);

    // ── Outgoing Python-proxy JSON options (re-used from P2-6) ──────

    private static readonly JsonSerializerOptions OutboundOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.BasicLatin, UnicodeRanges.Latin1Supplement),
    };

    /// <summary>Minimal JSON options for SSE-event payloads: camelCase +
    /// drop nulls. UTF-8 bytes go straight onto the wire so umlauts
    /// survive as plain bytes.</summary>
    private static readonly JsonSerializerOptions SseOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.BasicLatin, UnicodeRanges.Latin1Supplement),
    };

    // ── Registration ─────────────────────────────────────────────────

    public static void MapChatEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/chat").WithTags("Chat");

        group.MapGet("/sessions", ListSessionsAsync).RequireAuthorization();
        group.MapPost("/sessions", CreateSessionAsync).RequireAuthorization();
        group.MapPatch("/sessions/{id:guid}", RenameSessionAsync).RequireAuthorization();
        group.MapDelete("/sessions/{id:guid}", DeleteSessionAsync).RequireAuthorization();
        group.MapGet("/sessions/{id:guid}/messages", GetMessagesAsync).RequireAuthorization();

        group.MapPost("/sessions/{id:guid}/turn", TurnAsync)
            .RequireAuthorization()
            .RequireRateLimiting(RateLimitPolicies.ChatTurn);

        group.MapPost("/sessions/{id:guid}/to-recipe", ChatToRecipeAsync)
            .RequireAuthorization();
    }

    // ── GET /api/chat/sessions ───────────────────────────────────────

    private static async Task<IResult> ListSessionsAsync(
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        // SQLite (test provider) cannot ORDER BY DateTimeOffset, so we
        // materialise the filtered rows and sort in memory. Postgres
        // (prod) uses the server-side IX_ChatSessions_User_UpdatedAt
        // index directly.
        var isSqlite = IsSqlite(db);
        var query = db.ChatSessions.Where(s => s.UserId == callerId);
        List<ChatSessionListItemDto> rows;
        if (isSqlite)
        {
            var materialised = await query
                .Select(s => new ChatSessionListItemDto(
                    s.Id, s.Title, s.MessageCount, s.CreatedAt, s.UpdatedAt))
                .ToListAsync(ct);
            rows = materialised
                .OrderByDescending(r => r.UpdatedAt)
                .Take(SessionListLimit)
                .ToList();
        }
        else
        {
            rows = await query
                .OrderByDescending(s => s.UpdatedAt)
                .Take(SessionListLimit)
                .Select(s => new ChatSessionListItemDto(
                    s.Id, s.Title, s.MessageCount, s.CreatedAt, s.UpdatedAt))
                .ToListAsync(ct);
        }

        return Results.Json(rows, FamilienResults.JsonOptions);
    }

    // ── POST /api/chat/sessions ──────────────────────────────────────

    private static async Task<IResult> CreateSessionAsync(
        HttpContext ctx,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        var session = ChatSession.Create(callerId, clock.GetUtcNow());
        db.ChatSessions.Add(session);
        await db.SaveChangesAsync(ct);

        return Results.Json(
            new CreateSessionResponse(session.Id),
            FamilienResults.JsonOptions,
            statusCode: StatusCodes.Status200OK);
    }

    // ── PATCH /api/chat/sessions/{id} ────────────────────────────────

    private static async Task<IResult> RenameSessionAsync(
        Guid id,
        [FromBody] RenameSessionRequest? body,
        HttpContext ctx,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        if (body is null || string.IsNullOrWhiteSpace(body.Title))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidTitle,
                "Title must not be empty.",
                fieldName: "title");
        }
        if (body.Title.Length > ChatSession.TitleMaxLength)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidTitle,
                $"Title must be at most {ChatSession.TitleMaxLength} characters.",
                fieldName: "title");
        }

        var session = await LoadOwnedSessionAsync(db, id, callerId, ct);
        if (session is null) return Results.NotFound();

        try
        {
            session.Rename(body.Title, clock.GetUtcNow());
        }
        catch (ArgumentException)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidTitle,
                "Title is invalid.",
                fieldName: "title");
        }
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ── DELETE /api/chat/sessions/{id} ───────────────────────────────

    private static async Task<IResult> DeleteSessionAsync(
        Guid id,
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        var session = await LoadOwnedSessionAsync(db, id, callerId, ct);
        if (session is null) return Results.NotFound();

        db.ChatSessions.Remove(session);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ── GET /api/chat/sessions/{id}/messages ─────────────────────────

    private static async Task<IResult> GetMessagesAsync(
        Guid id,
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct,
        [FromQuery] DateTimeOffset? before = null,
        [FromQuery] int? limit = null)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        var session = await LoadOwnedSessionAsync(db, id, callerId, ct);
        if (session is null) return Results.NotFound();

        var take = Math.Clamp(
            limit ?? MessagesDefaultLimit, 1, MessagesMaxLimit);

        // The endpoint promises ASC order; for pagination we still
        // want the most-recent page first. Use a descending query + a
        // "before" cursor, then reverse the slice for display.
        // SQLite can't compare DateTimeOffset server-side; materialise
        // for sort + filter when running against it.
        var isSqlite = IsSqlite(db);
        List<ChatMessageDto> rows;
        if (isSqlite)
        {
            var all = await db.ChatMessages
                .Where(m => m.SessionId == id)
                .Select(m => new ChatMessageDto(
                    m.Id, RoleToString(m.Role), m.Content, m.CreatedAt))
                .ToListAsync(ct);
            var filtered = (before is DateTimeOffset c)
                ? all.Where(r => r.CreatedAt < c)
                : all;
            rows = filtered
                .OrderByDescending(r => r.CreatedAt)
                .Take(take)
                .OrderBy(r => r.CreatedAt)
                .ToList();
        }
        else
        {
            var query = db.ChatMessages.Where(m => m.SessionId == id);
            if (before is DateTimeOffset cursor)
                query = query.Where(m => m.CreatedAt < cursor);
            rows = await query
                .OrderByDescending(m => m.CreatedAt)
                .Take(take)
                .Select(m => new ChatMessageDto(
                    m.Id, RoleToString(m.Role), m.Content, m.CreatedAt))
                .ToListAsync(ct);
            rows.Reverse();
        }

        return Results.Json(rows, FamilienResults.JsonOptions);
    }

    // ── POST /api/chat/sessions/{id}/turn — SSE ─────────────────────

    private static async Task TurnAsync(
        Guid id,
        HttpContext ctx,
        AppDbContext db,
        IAzureOpenAIChatClient llm,
        IServiceScopeFactory scopeFactory,
        TimeProvider clock,
        ILoggerFactory loggerFactory,
        IExtractorConfigReader configReader,
        IBackgroundTaskTracker backgroundTasks,
        CancellationToken ct)
    {
        var logger = loggerFactory.CreateLogger("FamilienKochbuch.Api.Chat.Turn");

        // CFG-3 — kill switch. Fires BEFORE TryGetCallerId / DB lookup
        // / Azure call so an admin disable takes effect instantly and
        // cannot be bypassed by a user who's already past auth.
        // Fallback default matches the seed (true).
        if (!await configReader.GetFeatureFlagAsync(
                FeatureFlagKey, defaultValue: true, ct))
        {
            await WriteJsonErrorAsync(ctx, StatusCodes.Status503ServiceUnavailable,
                ErrorCodes.FeatureDisabled, "Chat is currently disabled.", ct);
            return;
        }

        if (!TryGetCallerId(ctx, out var callerId))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        // Parse the body ourselves — the endpoint writes SSE bytes on
        // the happy path so we can't return an IResult for validation
        // errors.  On invalid content we send a plain 400 + error JSON
        // body (no SSE headers yet at that point).
        TurnRequest? body;
        try
        {
            body = await ctx.Request.ReadFromJsonAsync<TurnRequest>(ct);
        }
        catch (JsonException)
        {
            await WriteJsonErrorAsync(ctx, StatusCodes.Status400BadRequest,
                ErrorCodes.InvalidBody, "Request body is not valid JSON.", ct);
            return;
        }

        if (body is null || string.IsNullOrWhiteSpace(body.Content))
        {
            await WriteJsonErrorAsync(ctx, StatusCodes.Status400BadRequest,
                ErrorCodes.InvalidContent, "Message content must not be empty.", ct);
            return;
        }
        if (body.Content.Length > TurnContentMaxLength)
        {
            await WriteJsonErrorAsync(ctx, StatusCodes.Status400BadRequest,
                ErrorCodes.ContentTooLong,
                $"Message content must be at most {TurnContentMaxLength} characters.", ct);
            return;
        }

        var session = await LoadOwnedSessionAsync(db, id, callerId, ct);
        if (session is null)
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var now = clock.GetUtcNow();

        // Persist user message first — even if the stream explodes
        // mid-flight the user's prompt is never lost.
        var userMessage = ChatMessage.Create(session.Id, ChatRole.User, body.Content, now);
        db.ChatMessages.Add(userMessage);
        session.RecordMessageAdded(now);
        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "chat turn start userId={UserId} sessionId={SessionId} contentLen={Len}",
            callerId, session.Id, body.Content.Length);

        // Build the LLM message array: system prompt + tail of history
        // (capped) + the just-persisted user turn (already in DB order).
        // SQLite can't ORDER BY DateTimeOffset so materialise then sort.
        var historyRaw = await db.ChatMessages
            .Where(m => m.SessionId == session.Id)
            .Select(m => new { m.Role, m.Content, m.CreatedAt })
            .ToListAsync(ct);
        var history = historyRaw
            .OrderByDescending(m => m.CreatedAt)
            .Take(MaxTurnsPerLlmCall)
            .OrderBy(m => m.CreatedAt)
            .Select(m => new { m.Role, m.Content })
            .ToList();

        // LANG-1b — capture the caller's UI language from
        // Accept-Language. Used for both the chat-turn system prompt
        // (this scope) and the fire-and-forget auto-title task below
        // — the title task runs in a fresh DI scope without the
        // originating HttpContext, so we copy the value into the
        // closure rather than re-reading the header from a stale ctx.
        var requestedLanguage = LanguageNormalizer.Normalise(
            ctx.Request.Headers.AcceptLanguage.ToString());

        var llmMessages = new List<ChatCompletionMessage>(history.Count + 1)
        {
            new("system", ChatSystemPrompt.Build(requestedLanguage)),
        };
        foreach (var m in history)
            llmMessages.Add(new ChatCompletionMessage(RoleToString(m.Role), m.Content));

        // Allocate the assistant row up-front so the SSE message-started
        // event can carry its id; AppendContent mutates Content as
        // tokens arrive.
        var assistantMessage = ChatMessage.Create(
            session.Id, ChatRole.Assistant, string.Empty, clock.GetUtcNow());
        db.ChatMessages.Add(assistantMessage);

        ConfigureSseHeaders(ctx);

        await WriteEventAsync(ctx, "message-started",
            new { messageId = assistantMessage.Id, role = "assistant" }, ct);

        ChatStreamChunk.Usage? usage = null;
        ChatStreamChunk.Error? firstError = null;
        var lastTokenAt = clock.GetUtcNow();
        bool clientDisconnected = false;

        try
        {
            await foreach (var chunk in llm.StreamAsync(llmMessages, ct).ConfigureAwait(false))
            {
                // Heartbeat — fire one before processing the next chunk
                // if the gap since the last client-visible event is
                // >= the heartbeat interval.
                if (clock.GetUtcNow() - lastTokenAt >= SseHeartbeatInterval)
                {
                    await WriteEventAsync(ctx, "heartbeat", new { }, ct);
                    lastTokenAt = clock.GetUtcNow();
                }

                switch (chunk)
                {
                    case ChatStreamChunk.Token token:
                        assistantMessage.AppendContent(token.Text);
                        await WriteEventAsync(ctx, "token",
                            new { text = token.Text }, ct);
                        lastTokenAt = clock.GetUtcNow();
                        break;
                    case ChatStreamChunk.Usage u:
                        usage = u;
                        break;
                    case ChatStreamChunk.Error e:
                        firstError ??= e;
                        break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Client disconnected mid-stream. Persist partial + bail.
            clientDisconnected = true;
            logger.LogDebug(
                "chat turn cancelled by client userId={UserId} sessionId={SessionId} streamedLen={Len}",
                callerId, session.Id, assistantMessage.Content.Length);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "chat turn unexpected error userId={UserId} sessionId={SessionId}",
                callerId, session.Id);
            firstError ??= new ChatStreamChunk.Error(
                "turn_failed", "Die Nachricht konnte nicht verarbeitet werden.");
        }

        // Emit usage (if we got one) and either done or error. On client
        // disconnect we skip the closing events — the pipe is already
        // half-gone and WriteEventAsync would throw.
        if (!clientDisconnected && !ctx.RequestAborted.IsCancellationRequested)
        {
            if (usage is not null)
            {
                await WriteEventAsync(ctx, "usage",
                    new
                    {
                        promptTokens = usage.Prompt,
                        completionTokens = usage.Completion,
                        cachedPromptTokens = usage.Cached,
                    }, ct);
            }

            if (firstError is not null)
            {
                await WriteEventAsync(ctx, "error",
                    new { code = firstError.Code, message = firstError.Message }, ct);
            }
            else
            {
                await WriteEventAsync(ctx, "done",
                    new { messageId = assistantMessage.Id }, ct);
            }
        }

        // Persist the assistant message + usage + session bookkeeping,
        // even on client disconnect — the user reopens the session and
        // sees whatever-was-streamed-so-far.
        try
        {
            if (usage is not null)
            {
                assistantMessage.RecordUsage(
                    usage.Prompt, usage.Completion, Math.Min(usage.Cached, usage.Prompt));
            }
            session.RecordMessageAdded(clock.GetUtcNow());

            if (usage is not null)
            {
                var log = new ChatUsageLog(
                    userId: callerId,
                    sessionId: session.Id.ToString(),
                    kind: ChatUsageKind.ChatTurn,
                    promptTokens: usage.Prompt,
                    completionTokens: usage.Completion,
                    cachedPromptTokens: Math.Min(usage.Cached, usage.Prompt),
                    modelDeployment: "azure-openai",
                    createdAt: clock.GetUtcNow());
                db.ChatUsageLogs.Add(log);
            }

            await db.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Failed to persist assistant message for session {SessionId}", session.Id);
        }

        // Fire-and-forget auto-title when this was the first turn and
        // no title is set. Race-guard: ChatTitleService re-checks the
        // Title-is-null invariant inside its own scope before saving
        // (Title-null-check-pattern, not Semaphore).
        if (!clientDisconnected && firstError is null && session.Title is null)
        {
            var sessionIdForTitle = session.Id;
            // LANG-1b — close over the already-normalised language so
            // the background task uses the originating turn's locale,
            // not whatever the next request happens to carry.
            var languageForTitle = requestedLanguage;
            backgroundTasks.Run(async () =>
            {
                using var scope = scopeFactory.CreateScope();
                var titleSvc = scope.ServiceProvider.GetRequiredService<ChatTitleService>();
                var bgLogger = scope.ServiceProvider
                    .GetRequiredService<ILoggerFactory>()
                    .CreateLogger("FamilienKochbuch.Api.Chat.Title");
                try
                {
                    await titleSvc.GenerateAsync(
                        sessionIdForTitle, languageForTitle, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    bgLogger.LogWarning(ex,
                        "Title generation failed for {SessionId}", sessionIdForTitle);
                }
            });
        }
    }

    // ── POST /api/chat/sessions/{id}/to-recipe (Python proxy) ────────

    private static async Task<IResult> ChatToRecipeAsync(
        Guid id,
        HttpContext ctx,
        IHttpClientFactory httpFactory,
        ExtractorHmacSigner signer,
        AppDbContext db,
        TimeProvider clock,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId)) return Results.Unauthorized();

        var session = await LoadOwnedSessionAsync(db, id, callerId, ct);
        if (session is null) return Results.NotFound();

        var raw = await db.ChatMessages
            .Where(m => m.SessionId == id
                     && (m.Role == ChatRole.User || m.Role == ChatRole.Assistant))
            .Select(m => new { m.Role, m.Content, m.CreatedAt })
            .ToListAsync(ct);
        var messages = raw.OrderBy(m => m.CreatedAt)
            .Select(m => new { m.Role, m.Content })
            .ToList();

        if (messages.Count == 0)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.MessagesRequired,
                "The conversation has no messages yet.");
        }

        // Safety net: cap message content before forwarding to Python;
        // the domain already bounds rows at 32 KiB but the Python side
        // has its own 8 000-char limit per message.
        var snake = messages.Select(m => new
        {
            role = RoleToString(m.Role),
            content = m.Content.Length > ToRecipeMessageMaxLength
                ? m.Content[..ToRecipeMessageMaxLength]
                : m.Content,
        }).ToArray();

        var pythonBody = new { messages = snake };
        var sessionIdPath = id.ToString("D");

        var logger = loggerFactory.CreateLogger("FamilienKochbuch.Api.Chat");
        logger.LogInformation(
            "chat_to_recipe userId={UserId} sessionId={SessionId} turnCount={TurnCount}",
            callerId, sessionIdPath, snake.Length);

        // LANG-1 — propagate the caller's UI language to Python so the
        // verdichtete recipe-JSON's structured-field values land in the
        // user's language. Sync proxy path: read directly from the
        // request, no persistence step (this isn't a Hangfire job).
        var requestedLanguage = Services.LanguageNormalizer.Normalise(
            ctx.Request.Headers.AcceptLanguage.ToString());

        return await ForwardToPythonAsync(
            httpFactory,
            signer,
            callerId,
            relativeUrl: $"/chat/{sessionIdPath}/to-recipe",
            pythonBody,
            usageContext: new UsageLogContext(db, clock, sessionIdPath, ChatUsageKind.ChatToRecipe),
            requestedLanguage: requestedLanguage,
            ct);
    }

    // ── Python proxy helper (verbatim P2-6 shape) ───────────────────

    private sealed record UsageLogContext(
        AppDbContext Db,
        TimeProvider Clock,
        string SessionId,
        ChatUsageKind Kind);

    private static async Task<IResult> ForwardToPythonAsync<TBody>(
        IHttpClientFactory httpFactory,
        ExtractorHmacSigner signer,
        Guid callerId,
        string relativeUrl,
        TBody body,
        UsageLogContext usageContext,
        string requestedLanguage,
        CancellationToken ct)
    {
        var client = httpFactory.CreateClient(ExtractRecipeFromUrlJob.HttpClientName);
        var json = JsonSerializer.SerializeToUtf8Bytes(body, OutboundOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl)
        {
            Content = new ByteArrayContent(json),
        };
        request.Content.Headers.ContentType =
            new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        await signer.ApplyAsync(request, callerId, ct);

        // LANG-1 — outbound Accept-Language so the FastAPI dependency
        // on the Python side picks up the user's UI language.
        request.Headers.TryAddWithoutValidation("Accept-Language", requestedLanguage);

        HttpResponseMessage response;
        string bodyText;
        try
        {
            response = await client.SendAsync(request, ct).ConfigureAwait(false);
            bodyText = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (HttpRequestException)
        {
            return PythonProxyErrorMapper.MapTransportFailure();
        }
        catch (TaskCanceledException) when (!ct.IsCancellationRequested)
        {
            return PythonProxyErrorMapper.MapTransportFailure();
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
                return PythonProxyErrorMapper.MapErrorResponse(response, bodyText);

            if (UsageHeaders.TryRead(
                    response, out var prompt, out var completion,
                    out var cached, out var model))
            {
                var log = new ChatUsageLog(
                    userId: callerId,
                    sessionId: usageContext.SessionId,
                    kind: usageContext.Kind,
                    promptTokens: prompt,
                    completionTokens: completion,
                    cachedPromptTokens: cached,
                    modelDeployment: model,
                    createdAt: usageContext.Clock.GetUtcNow());
                usageContext.Db.ChatUsageLogs.Add(log);
                await usageContext.Db.SaveChangesAsync(ct);
            }

            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/json";
            return Results.Content(bodyText, contentType, Encoding.UTF8, StatusCodes.Status200OK);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /// <summary>
    /// Centralised ownership check: load a session by id only when the
    /// caller owns it. Returns <c>null</c> otherwise — callers map this
    /// to 404 (never 403, to hide cross-tenant existence).
    /// </summary>
    private static Task<ChatSession?> LoadOwnedSessionAsync(
        AppDbContext db, Guid sessionId, Guid callerId, CancellationToken ct)
        => db.ChatSessions
            .FirstOrDefaultAsync(s => s.Id == sessionId && s.UserId == callerId, ct);

    private static void ConfigureSseHeaders(HttpContext ctx)
    {
        ctx.Response.StatusCode = StatusCodes.Status200OK;
        ctx.Response.ContentType = "text/event-stream; charset=utf-8";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";
        ctx.Response.Headers.Connection = "keep-alive";
    }

    /// <summary>
    /// Write a single SSE event as <c>event: &lt;name&gt;\ndata: &lt;json&gt;\n\n</c>
    /// and flush. UTF-8 bytes go on the wire so umlauts in the data
    /// payload never get lost. Swallows connection-aborted errors to
    /// match the endpoint's disconnect tolerance.
    /// </summary>
    private static async Task WriteEventAsync(
        HttpContext ctx, string name, object payload, CancellationToken ct)
    {
        if (ctx.RequestAborted.IsCancellationRequested) return;
        try
        {
            var line = $"event: {name}\ndata: {JsonSerializer.Serialize(payload, SseOptions)}\n\n";
            var bytes = Encoding.UTF8.GetBytes(line);
            await ctx.Response.Body.WriteAsync(bytes, ct).ConfigureAwait(false);
            await ctx.Response.Body.FlushAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Client disconnected between chunks; caller persists partial.
        }
        catch (IOException)
        {
            // Pipe broken — same semantic as cancellation.
        }
    }

    private static async Task WriteJsonErrorAsync(
        HttpContext ctx, int status, string code, string message, CancellationToken ct)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        // REL-4 — wire shape must match the rest of the API (code,
        // message, status) even on the SSE-adjacent path that can't
        // return an IResult. Construct the same ErrorResponse the
        // FamilienResults helpers emit and serialise it here.
        var payload = JsonSerializer.SerializeToUtf8Bytes(
            new ErrorResponse(code, message, status),
            FamilienResults.JsonOptions);
        await ctx.Response.Body.WriteAsync(payload, ct);
    }

    /// <summary>
    /// True when the current EF provider is SQLite (test path). Used to
    /// swap to in-memory sorts where server-side <c>ORDER BY</c> on
    /// <see cref="DateTimeOffset"/> is not supported.
    /// </summary>
    private static bool IsSqlite(AppDbContext db) =>
        (db.Database.ProviderName ?? string.Empty)
            .Contains("Sqlite", StringComparison.OrdinalIgnoreCase);

    private static string RoleToString(ChatRole role) => role switch
    {
        ChatRole.User => "user",
        ChatRole.Assistant => "assistant",
        _ => "system",
    };

    private static bool TryGetCallerId(HttpContext ctx, out Guid callerId)
    {
        callerId = Guid.Empty;
        var sub = ctx.User.FindFirstValue(JwtRegisteredClaimNames.Sub);
        return !string.IsNullOrWhiteSpace(sub) && Guid.TryParse(sub, out callerId);
    }
}
