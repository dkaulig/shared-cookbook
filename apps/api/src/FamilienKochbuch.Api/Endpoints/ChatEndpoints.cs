using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Unicode;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// P2-6 chat bridge: synchronous .NET-side proxy in front of the
/// Python extractor's chat surface.
///
/// <list type="bullet">
/// <item><c>POST /api/chat</c> — one conversational turn. Forwards
/// <c>{ session_id, messages }</c> verbatim (after shape validation).
/// </item>
/// <item><c>POST /api/chat/{sessionId}/to-recipe</c> — condense the
/// conversation into a structured recipe. Forwards <c>{ messages }</c>;
/// the session id lives in the URL path on Python's side.</item>
/// </list>
///
/// These are <em>synchronous</em> proxies (not Hangfire jobs): a chat
/// turn typically completes in &lt; 5 s; the "to-recipe" structuring
/// call in 2–10 s — both fit inside a regular HTTP request/response.
/// Background-queueing would add latency + a separate status polling
/// loop the frontend doesn't want.
///
/// The endpoints parse the request body into strongly-typed DTOs
/// (shape-validated), re-serialise them with snake_case for Python, and
/// sign the outgoing request via <see cref="ExtractorHmacSigner"/>. The
/// response is parsed and re-serialised in camelCase before being
/// returned to the caller so the web surface keeps its JSON conventions.
///
/// Error mapping goes through <see cref="PythonProxyErrorMapper"/> —
/// kept central so every proxy endpoint translates codes the same way
/// (FastAPI 422 → .NET 400, Python 401 masked as .NET 500, etc.).
///
/// Logging deliberately never includes message content (PRD §5.4 —
/// "don't make server logs a transcript archive").
/// </summary>
public static class ChatEndpoints
{
    /// <summary>camelCase JSON body used by the incoming request. The
    /// frontend speaks camelCase across the whole .NET surface; we
    /// re-map to snake_case on the outgoing call to Python.</summary>
    public sealed record ChatMessageDto(string Role, string Content);

    /// <summary>Body of <c>POST /api/chat</c>.</summary>
    public sealed record ChatTurnRequest(string SessionId, ChatMessageDto[] Messages);

    /// <summary>Body of <c>POST /api/chat/{sessionId}/to-recipe</c>.
    /// Note the absence of a session id in the body — it rides in the
    /// URL path to match Python's route shape.</summary>
    public sealed record ChatToRecipeRequest(ChatMessageDto[] Messages);

    /// <summary>Strict set of roles the bridge accepts. Anything else
    /// gets rejected at the .NET edge rather than letting it reach
    /// Python — saves a round-trip on bad input.</summary>
    private static readonly HashSet<string> AllowedRoles = new(StringComparer.Ordinal)
    {
        "system", "user", "assistant",
    };

    /// <summary>Upper bound on a single message's content length.
    /// Mirrors Python's pydantic <c>max_length=8000</c> so callers get
    /// the fail at the .NET edge (with our uniform error shape)
    /// rather than at Python's 422.</summary>
    public const int MaxMessageContentLength = 8000;

    /// <summary>Upper bound on session id length (matches Python
    /// constraint).</summary>
    public const int MaxSessionIdLength = 200;

    /// <summary>JSON options the outgoing Python body uses — snake_case,
    /// no-null-writing, and an encoder that keeps German umlauts
    /// (ä/ö/ü/ß) as plain UTF-8 bytes on the wire rather than encoding
    /// them as \u escapes. FastAPI/pydantic accept either form, but the
    /// raw form is the obvious choice for a body we'll want to grep.
    /// </summary>
    private static readonly JsonSerializerOptions OutboundOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.BasicLatin, UnicodeRanges.Latin1Supplement),
    };

    public static void MapChatEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/chat").WithTags("Chat");
        group.MapPost("/", ChatTurnAsync).RequireAuthorization();
        group.MapPost("/{sessionId}/to-recipe", ChatToRecipeAsync).RequireAuthorization();
    }

    // ── POST /api/chat ───────────────────────────────────────────────

    private static async Task<IResult> ChatTurnAsync(
        ChatTurnRequest body,
        HttpContext ctx,
        IHttpClientFactory httpFactory,
        ExtractorHmacSigner signer,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId))
            return Results.Unauthorized();

        if (body is null
            || string.IsNullOrWhiteSpace(body.SessionId)
            || body.SessionId.Length > MaxSessionIdLength)
        {
            return FamilienResults.BadRequest(
                "invalid_session_id",
                "Die Session-ID ist erforderlich.");
        }

        if (!TryValidateMessages(body.Messages, out var badMessage))
            return badMessage!;

        // Re-serialise with snake_case for Python. Doing this via DTO
        // shape (rather than piping raw bytes) lets .NET reject garbage
        // upstream and keeps the request body shape aligned with
        // FastAPI's pydantic schema.
        var pythonBody = new
        {
            session_id = body.SessionId,
            messages = body.Messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
        };

        var logger = loggerFactory.CreateLogger("FamilienKochbuch.Api.Chat");
        logger.LogInformation(
            "chat turn userId={UserId} sessionId={SessionId} turnCount={TurnCount}",
            callerId, body.SessionId, body.Messages.Length);

        return await ForwardAsync(
            httpFactory,
            signer,
            callerId,
            relativeUrl: "/chat",
            pythonBody,
            ct);
    }

    // ── POST /api/chat/{sessionId}/to-recipe ─────────────────────────

    private static async Task<IResult> ChatToRecipeAsync(
        string sessionId,
        ChatToRecipeRequest body,
        HttpContext ctx,
        IHttpClientFactory httpFactory,
        ExtractorHmacSigner signer,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (!TryGetCallerId(ctx, out var callerId))
            return Results.Unauthorized();

        if (string.IsNullOrWhiteSpace(sessionId)
            || sessionId.Length > MaxSessionIdLength)
        {
            return FamilienResults.BadRequest(
                "invalid_session_id",
                "Die Session-ID ist ungültig.");
        }

        if (body is null)
            return FamilienResults.BadRequest(
                "messages_required",
                "Die Nachrichtenliste ist erforderlich.");
        if (!TryValidateMessages(body.Messages, out var badMessage))
            return badMessage!;

        // Python's /chat/{sid}/to-recipe takes only messages in the body.
        var pythonBody = new
        {
            messages = body.Messages.Select(m => new { role = m.Role, content = m.Content }).ToArray(),
        };

        var logger = loggerFactory.CreateLogger("FamilienKochbuch.Api.Chat");
        logger.LogInformation(
            "chat_to_recipe userId={UserId} sessionId={SessionId} turnCount={TurnCount}",
            callerId, sessionId, body.Messages.Length);

        return await ForwardAsync(
            httpFactory,
            signer,
            callerId,
            relativeUrl: $"/chat/{Uri.EscapeDataString(sessionId)}/to-recipe",
            pythonBody,
            ct);
    }

    // ── Shared forwarding + validation helpers ──────────────────────

    /// <summary>
    /// Forwards the given body to Python on the named
    /// <c>"python-extractor"</c> HttpClient, signs with HMAC, and maps
    /// the response through <see cref="PythonProxyErrorMapper"/> on any
    /// non-success status. On 2xx the Python JSON body is re-emitted
    /// verbatim so the downstream caller sees the same shape.
    /// </summary>
    private static async Task<IResult> ForwardAsync<TBody>(
        IHttpClientFactory httpFactory,
        ExtractorHmacSigner signer,
        Guid callerId,
        string relativeUrl,
        TBody body,
        CancellationToken ct)
    {
        var client = httpFactory.CreateClient(ExtractRecipeFromUrlJob.HttpClientName);
        // Serialise to bytes up-front so the signer sees the exact same
        // body the HttpClient ships. Using JsonContent.Create directly
        // is also fine — ApplyAsync reads the stream back — but going
        // through ByteArrayContent avoids any chance of the content
        // being consumed twice with different buffering semantics.
        var json = JsonSerializer.SerializeToUtf8Bytes(body, OutboundOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, relativeUrl)
        {
            Content = new ByteArrayContent(json),
        };
        request.Content.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        await signer.ApplyAsync(request, callerId, ct);

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

            // Re-emit the body verbatim. The response is already JSON in
            // Python's snake_case shape; keeping it as-is means the
            // frontend gets the same fields it would from a direct
            // Python call, which matches the plan's "proxy semantics"
            // promise.
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/json";
            return Results.Content(bodyText, contentType, Encoding.UTF8, StatusCodes.Status200OK);
        }
    }

    /// <summary>Validates the messages array's shape before spending a
    /// round-trip to Python. Returns <c>false</c> + an
    /// <see cref="IResult"/> in <paramref name="errorResult"/> on any
    /// violation.</summary>
    private static bool TryValidateMessages(ChatMessageDto[]? messages, out IResult? errorResult)
    {
        errorResult = null;
        if (messages is null || messages.Length == 0)
        {
            errorResult = FamilienResults.BadRequest(
                "messages_required",
                "Die Nachrichtenliste ist erforderlich.");
            return false;
        }

        foreach (var m in messages)
        {
            if (m is null
                || string.IsNullOrWhiteSpace(m.Role)
                || !AllowedRoles.Contains(m.Role))
            {
                errorResult = FamilienResults.BadRequest(
                    "invalid_role",
                    "Ungültige Rolle — erlaubt sind system, user, assistant.");
                return false;
            }
            if (string.IsNullOrWhiteSpace(m.Content))
            {
                errorResult = FamilienResults.BadRequest(
                    "invalid_message",
                    "Nachrichteninhalt darf nicht leer sein.");
                return false;
            }
            if (m.Content.Length > MaxMessageContentLength)
            {
                errorResult = FamilienResults.BadRequest(
                    "message_too_long",
                    $"Nachrichten dürfen höchstens {MaxMessageContentLength} Zeichen lang sein.");
                return false;
            }
        }
        return true;
    }

    private static bool TryGetCallerId(HttpContext ctx, out Guid callerId)
    {
        callerId = Guid.Empty;
        var sub = ctx.User.FindFirstValue(
            System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub);
        return !string.IsNullOrWhiteSpace(sub) && Guid.TryParse(sub, out callerId);
    }
}
