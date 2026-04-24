using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// CR2 — end-to-end coverage for the rewritten chat surface:
/// session list / create / rename / delete / load-messages / SSE turn
/// / to-recipe proxy. The SSE turn tests inject a deterministic
/// <see cref="FakeAzureOpenAIChatClient"/> (configured once in the
/// WebApplicationFactory) so assertions cover the SSE event sequence
/// and on-disk persistence without any network IO.
/// </summary>
public class ChatEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public ChatEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.ExtractorHandler.Reset();
        _factory.AzureOpenAi.Reset();
        // FLAKY-1 — drain any background tasks from the previous test
        // (e.g. a turn that scheduled an auto-title we never awaited)
        // before touching the DB, so the ResetAsync delete chain can't
        // race a still-running DbContext write on the shared SQLite
        // connection.
        await _factory.BackgroundTasks.WhenAllAsync();
        await ResetAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.ChatMessages.RemoveRange(db.ChatMessages);
        db.ChatSessions.RemoveRange(db.ChatSessions);
        db.ChatUsageLogs.RemoveRange(db.ChatUsageLogs);
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();

        // CFG-3 — the class-fixture SQLite connection persists between
        // tests; restore the chat feature-flag row to its seed default
        // (true) so a test that disabled / deleted it doesn't poison
        // the next test's assertions.
        var flag = await db.ExtractorConfigs
            .FirstOrDefaultAsync(c => c.Key == ChatEndpoints.FeatureFlagKey);
        if (flag is null)
        {
            db.ExtractorConfigs.Add(new FamilienKochbuch.Domain.Entities.ExtractorConfig(
                ChatEndpoints.FeatureFlagKey,
                "true",
                FamilienKochbuch.Domain.Entities.ExtractorConfigValueType.Bool,
                _factory.Clock.GetUtcNow(),
                updatedBy: null));
            await db.SaveChangesAsync();
        }
        else if (flag.ValueJson != "true")
        {
            flag.UpdateValue("true", _factory.Clock.GetUtcNow(), updatedBy: null);
            await db.SaveChangesAsync();
        }
    }

    // ── Auth helpers (same pattern as the P2-6 suite) ───────────────

    private async Task<(Guid userId, string token)> SignupAsync(string email, string displayName)
    {
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Headers.Add("X-Test-Disable-RateLimit", "true");
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        using var signupReq = new HttpRequestMessage(HttpMethod.Post,
            $"/api/auth/signup?token={invite!.Token}");
        signupReq.Headers.Add("X-Test-Disable-RateLimit", "true");
        signupReq.Content = JsonContent.Create(
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        var signup = await _client.SendAsync(signupReq);
        signup.EnsureSuccessStatusCode();
        var body = await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        return (body!.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login");
        req.Headers.Add("X-Test-Disable-RateLimit", "true");
        req.Content = JsonContent.Create(new AuthEndpoints.LoginRequest(email, password));
        var response = await _client.SendAsync(req);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    private HttpRequestMessage Authed(HttpMethod method, string path, string token)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return req;
    }

    // ── DTOs used in test assertions ────────────────────────────────

    private sealed record SessionRow(Guid Id, string? Title, int MessageCount,
        DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

    private sealed record MessageRow(Guid Id, string Role, string Content, DateTimeOffset CreatedAt);

    private sealed record CreateSessionResponseDto(Guid SessionId);

    // ── Low-level DB seeds (bypass endpoint layer) ──────────────────

    private async Task<Guid> SeedSessionAsync(Guid userId, string? title = null, DateTimeOffset? updatedAt = null)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var now = updatedAt ?? _factory.Clock.GetUtcNow();
        var session = ChatSession.Create(userId, now);
        if (title is not null) session.Rename(title, now);
        db.ChatSessions.Add(session);
        await db.SaveChangesAsync();
        return session.Id;
    }

    private async Task SeedMessageAsync(Guid sessionId, ChatRole role, string content, DateTimeOffset createdAt)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var msg = ChatMessage.Create(sessionId, role, content, createdAt);
        db.ChatMessages.Add(msg);
        await db.SaveChangesAsync();
    }

    // ── GET /api/chat/sessions ──────────────────────────────────────

    [Fact]
    public async Task ListSessions_Anonymous_Gets_401()
    {
        var response = await _client.GetAsync("/api/chat/sessions");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ListSessions_Empty_Returns_EmptyArray()
    {
        var (_, token) = await SignupAsync("list-empty@ex.com", "Chat");
        using var req = Authed(HttpMethod.Get, "/api/chat/sessions", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var rows = await response.Content.ReadFromJsonAsync<SessionRow[]>();
        Assert.NotNull(rows);
        Assert.Empty(rows!);
    }

    [Fact]
    public async Task ListSessions_Returns_NewestFirst()
    {
        var (userId, token) = await SignupAsync("list-two@ex.com", "Chat");
        var older = await SeedSessionAsync(userId, "Alt", _factory.Clock.GetUtcNow().AddHours(-1));
        var newer = await SeedSessionAsync(userId, "Neu", _factory.Clock.GetUtcNow());

        using var req = Authed(HttpMethod.Get, "/api/chat/sessions", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var rows = (await response.Content.ReadFromJsonAsync<SessionRow[]>())!;
        Assert.Equal(2, rows.Length);
        Assert.Equal(newer, rows[0].Id);
        Assert.Equal(older, rows[1].Id);
    }

    [Fact]
    public async Task ListSessions_CrossUser_Invisible()
    {
        var (userAId, tokenA) = await SignupAsync("user-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("user-b@ex.com", "B");
        await SeedSessionAsync(userAId, "A-Session");

        using var reqB = Authed(HttpMethod.Get, "/api/chat/sessions", tokenB);
        var resB = await _client.SendAsync(reqB);
        Assert.Equal(HttpStatusCode.OK, resB.StatusCode);
        var rowsB = (await resB.Content.ReadFromJsonAsync<SessionRow[]>())!;
        Assert.Empty(rowsB);

        using var reqA = Authed(HttpMethod.Get, "/api/chat/sessions", tokenA);
        var resA = await _client.SendAsync(reqA);
        var rowsA = (await resA.Content.ReadFromJsonAsync<SessionRow[]>())!;
        Assert.Single(rowsA);
    }

    // ── POST /api/chat/sessions ─────────────────────────────────────

    [Fact]
    public async Task CreateSession_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat/sessions");
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CreateSession_Returns_SessionId()
    {
        var (userId, token) = await SignupAsync("create@ex.com", "Chat");
        using var req = Authed(HttpMethod.Post, "/api/chat/sessions", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<CreateSessionResponseDto>();
        Assert.NotEqual(Guid.Empty, body!.SessionId);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var session = await db.ChatSessions.SingleAsync(s => s.Id == body.SessionId);
        Assert.Equal(userId, session.UserId);
        Assert.Null(session.Title);
    }

    // ── PATCH /api/chat/sessions/{id} ───────────────────────────────

    [Fact]
    public async Task RenameSession_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Patch, $"/api/chat/sessions/{Guid.NewGuid()}");
        req.Content = JsonContent.Create(new { title = "X" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task RenameSession_Unknown_Gets_404()
    {
        var (_, token) = await SignupAsync("rename-unknown@ex.com", "Chat");
        using var req = Authed(HttpMethod.Patch, $"/api/chat/sessions/{Guid.NewGuid()}", token);
        req.Content = JsonContent.Create(new { title = "X" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task RenameSession_CrossUser_Gets_404()
    {
        var (userAId, _) = await SignupAsync("rename-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("rename-b@ex.com", "B");
        var sessionId = await SeedSessionAsync(userAId);
        using var req = Authed(HttpMethod.Patch, $"/api/chat/sessions/{sessionId}", tokenB);
        req.Content = JsonContent.Create(new { title = "Hijack" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task RenameSession_EmptyTitle_Gets_400()
    {
        var (userId, token) = await SignupAsync("rename-empty@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Patch, $"/api/chat/sessions/{sessionId}", token);
        req.Content = JsonContent.Create(new { title = "   " });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task RenameSession_TooLongTitle_Gets_400()
    {
        var (userId, token) = await SignupAsync("rename-long@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Patch, $"/api/chat/sessions/{sessionId}", token);
        req.Content = JsonContent.Create(new { title = new string('x', ChatSession.TitleMaxLength + 1) });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task RenameSession_Happy_Updates_Title()
    {
        var (userId, token) = await SignupAsync("rename-ok@ex.com", "Chat");
        // NOTE: we deliberately do NOT call _factory.Clock.Advance here —
        // the JWT token lifetime path reads the FakeTimeProvider; advancing
        // the fake past the real system clock's window produces notBefore
        // values in the future, which the JwtBearer middleware (bound to
        // real time) rejects as NotYetValid. Advancing Clock would break
        // *every subsequent test* in this class. Instead we seed the session
        // one minute in the past and assert the endpoint bumps UpdatedAt.
        var pastCreated = _factory.Clock.GetUtcNow().AddMinutes(-1);
        var sessionId = await SeedSessionAsync(userId, updatedAt: pastCreated);

        using var req = Authed(HttpMethod.Patch, $"/api/chat/sessions/{sessionId}", token);
        req.Content = JsonContent.Create(new { title = "Pasta-Abend" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var reloaded = await db.ChatSessions.SingleAsync(s => s.Id == sessionId);
        Assert.Equal("Pasta-Abend", reloaded.Title);
        Assert.True(reloaded.UpdatedAt > pastCreated);
    }

    // ── DELETE /api/chat/sessions/{id} ──────────────────────────────

    [Fact]
    public async Task DeleteSession_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Delete, $"/api/chat/sessions/{Guid.NewGuid()}");
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task DeleteSession_Unknown_Gets_404()
    {
        var (_, token) = await SignupAsync("del-unknown@ex.com", "Chat");
        using var req = Authed(HttpMethod.Delete, $"/api/chat/sessions/{Guid.NewGuid()}", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task DeleteSession_CrossUser_Gets_404()
    {
        var (userAId, _) = await SignupAsync("del-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("del-b@ex.com", "B");
        var sessionId = await SeedSessionAsync(userAId);
        using var req = Authed(HttpMethod.Delete, $"/api/chat/sessions/{sessionId}", tokenB);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task DeleteSession_CascadesMessages()
    {
        var (userId, token) = await SignupAsync("del-cascade@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        await SeedMessageAsync(sessionId, ChatRole.User, "Hi", _factory.Clock.GetUtcNow());
        await SeedMessageAsync(sessionId, ChatRole.Assistant, "Hallo", _factory.Clock.GetUtcNow());

        using var req = Authed(HttpMethod.Delete, $"/api/chat/sessions/{sessionId}", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.ChatSessions.AnyAsync(s => s.Id == sessionId));
        Assert.False(await db.ChatMessages.AnyAsync(m => m.SessionId == sessionId));
    }

    // ── GET /api/chat/sessions/{id}/messages ────────────────────────

    [Fact]
    public async Task GetMessages_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/chat/sessions/{Guid.NewGuid()}/messages");
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetMessages_Unknown_Gets_404()
    {
        var (_, token) = await SignupAsync("msg-unknown@ex.com", "Chat");
        using var req = Authed(HttpMethod.Get, $"/api/chat/sessions/{Guid.NewGuid()}/messages", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetMessages_CrossUser_Gets_404()
    {
        var (userAId, _) = await SignupAsync("msg-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("msg-b@ex.com", "B");
        var sessionId = await SeedSessionAsync(userAId);
        using var req = Authed(HttpMethod.Get, $"/api/chat/sessions/{sessionId}/messages", tokenB);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task GetMessages_Empty_Returns_EmptyArray()
    {
        var (userId, token) = await SignupAsync("msg-empty@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Get, $"/api/chat/sessions/{sessionId}/messages", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var rows = await response.Content.ReadFromJsonAsync<MessageRow[]>();
        Assert.NotNull(rows);
        Assert.Empty(rows!);
    }

    [Fact]
    public async Task GetMessages_Returns_AscOrder()
    {
        var (userId, token) = await SignupAsync("msg-order@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        var t0 = _factory.Clock.GetUtcNow();
        await SeedMessageAsync(sessionId, ChatRole.User, "A", t0);
        await SeedMessageAsync(sessionId, ChatRole.Assistant, "B", t0.AddSeconds(1));
        await SeedMessageAsync(sessionId, ChatRole.User, "C", t0.AddSeconds(2));

        using var req = Authed(HttpMethod.Get, $"/api/chat/sessions/{sessionId}/messages", token);
        var response = await _client.SendAsync(req);
        var rows = (await response.Content.ReadFromJsonAsync<MessageRow[]>())!;
        Assert.Equal(3, rows.Length);
        Assert.Equal("A", rows[0].Content);
        Assert.Equal("B", rows[1].Content);
        Assert.Equal("C", rows[2].Content);
    }

    [Fact]
    public async Task GetMessages_Pagination_Before_And_Limit()
    {
        var (userId, token) = await SignupAsync("msg-paginate@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        var t0 = _factory.Clock.GetUtcNow();
        for (var i = 0; i < 5; i++)
            await SeedMessageAsync(sessionId, ChatRole.User, $"M{i}", t0.AddSeconds(i));

        // limit=2 → most-recent 2 returned in ASC order
        using var req = Authed(HttpMethod.Get,
            $"/api/chat/sessions/{sessionId}/messages?limit=2", token);
        var response = await _client.SendAsync(req);
        var rows = (await response.Content.ReadFromJsonAsync<MessageRow[]>())!;
        Assert.Equal(2, rows.Length);
        Assert.Equal("M3", rows[0].Content);
        Assert.Equal("M4", rows[1].Content);

        // before=<M3.CreatedAt> + limit=2 → M1, M2
        var before = Uri.EscapeDataString(t0.AddSeconds(3).ToString("O"));
        using var req2 = Authed(HttpMethod.Get,
            $"/api/chat/sessions/{sessionId}/messages?before={before}&limit=2", token);
        var response2 = await _client.SendAsync(req2);
        var rows2 = (await response2.Content.ReadFromJsonAsync<MessageRow[]>())!;
        Assert.Equal(2, rows2.Length);
        Assert.Equal("M1", rows2[0].Content);
        Assert.Equal("M2", rows2[1].Content);
    }

    // ── POST /api/chat/sessions/{id}/turn (SSE) ─────────────────────

    /// <summary>
    /// Read a chat/turn stream with <c>ResponseHeadersRead</c> and parse
    /// each SSE block into (event-name, data-json). Blocks until the
    /// stream closes. Use from tests that want the whole event
    /// sequence.
    /// </summary>
    private static async Task<List<(string Name, string Data)>> ReadSseAsync(
        HttpResponseMessage response, CancellationToken ct = default)
    {
        var events = new List<(string, string)>();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        string? eventName = null;
        string? data = null;
        while (true)
        {
            var line = await reader.ReadLineAsync(ct);
            if (line is null) break;
            if (line.Length == 0)
            {
                if (eventName is not null && data is not null)
                    events.Add((eventName, data));
                eventName = null;
                data = null;
                continue;
            }
            if (line.StartsWith("event:", StringComparison.Ordinal))
                eventName = line["event:".Length..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal))
                data = line["data:".Length..].Trim();
        }
        return events;
    }

    [Fact]
    public async Task Turn_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"/api/chat/sessions/{Guid.NewGuid()}/turn");
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Turn_Unknown_Session_Gets_404()
    {
        var (_, token) = await SignupAsync("turn-404@ex.com", "Chat");
        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{Guid.NewGuid()}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Turn_CrossUser_Gets_404()
    {
        var (userAId, _) = await SignupAsync("turn-cross-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("turn-cross-b@ex.com", "B");
        var sessionId = await SeedSessionAsync(userAId);
        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", tokenB);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Turn_EmptyContent_Gets_400()
    {
        var (userId, token) = await SignupAsync("turn-empty@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "" });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Turn_TooLongContent_Gets_400()
    {
        var (userId, token) = await SignupAsync("turn-long@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = new string('x', ChatEndpoints.TurnContentMaxLength + 1) });
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Turn_Streams_MessageStarted_Tokens_Usage_Done()
    {
        var (userId, token) = await SignupAsync("turn-stream@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("Hallo", " Welt", "!")
            .QueueUsage(prompt: 42, completion: 9, cached: 10)
            .SetTitle("Titel X");

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Zeig mir ein Nudelrezept" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);

        var events = await ReadSseAsync(response);
        Assert.NotEmpty(events);
        Assert.Equal("message-started", events[0].Name);
        Assert.Contains(events, e => e.Name == "token");
        Assert.Contains(events, e => e.Name == "usage");
        Assert.Equal("done", events[^1].Name);

        // Token order + content
        var tokens = events.Where(e => e.Name == "token")
            .Select(e => JsonDocument.Parse(e.Data).RootElement.GetProperty("text").GetString())
            .ToArray();
        Assert.Equal(new[] { "Hallo", " Welt", "!" }, tokens);

        var usage = events.Single(e => e.Name == "usage");
        var usageDoc = JsonDocument.Parse(usage.Data).RootElement;
        Assert.Equal(42, usageDoc.GetProperty("promptTokens").GetInt32());
        Assert.Equal(9, usageDoc.GetProperty("completionTokens").GetInt32());
        // cachedPromptTokens clamped to <= promptTokens on persist; the
        // SSE event carries the raw value from the Azure chunk as-is.
        Assert.True(usageDoc.GetProperty("cachedPromptTokens").GetInt32() >= 0);
    }

    [Fact]
    public async Task Turn_Persists_User_And_Assistant_Messages()
    {
        var (userId, token) = await SignupAsync("turn-persist@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal(0, await db.ChatMessages.CountAsync(m => m.SessionId == sessionId));
        }

        _factory.AzureOpenAi
            .QueueTokens("Probier", " Spätzle.")
            .QueueUsage(100, 8, 0);

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Ich hab Kartoffeln und Quark." });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        await ReadSseAsync(response);

        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            // SQLite can't ORDER BY DateTimeOffset server-side; materialise
            // + client-sort. Postgres (prod) uses the native index.
            var loaded = await db.ChatMessages
                .Where(m => m.SessionId == sessionId)
                .ToListAsync();
            var rows = loaded.OrderBy(m => m.CreatedAt).ToList();
            Assert.Equal(2, rows.Count);
            Assert.Equal(ChatRole.User, rows[0].Role);
            Assert.Equal("Ich hab Kartoffeln und Quark.", rows[0].Content);
            Assert.Equal(ChatRole.Assistant, rows[1].Role);
            Assert.Equal("Probier Spätzle.", rows[1].Content);
            Assert.Equal(100, rows[1].PromptTokens);
            Assert.Equal(8, rows[1].CompletionTokens);
        }
    }

    [Fact]
    public async Task Turn_Writes_ChatUsageLog_With_ChatTurn_Kind()
    {
        var (userId, token) = await SignupAsync("turn-usage@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("ok")
            .QueueUsage(123, 45, 10);

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        await ReadSseAsync(response);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var log = await db.ChatUsageLogs.SingleAsync(c => c.UserId == userId);
        Assert.Equal(ChatUsageKind.ChatTurn, log.Kind);
        Assert.Equal(123, log.PromptTokens);
        Assert.Equal(45, log.CompletionTokens);
        Assert.Equal(sessionId.ToString("D"), log.SessionId);
    }

    [Fact]
    public async Task Turn_Stream_Ending_With_Error_Persists_Partial()
    {
        // Mid-stream cancellation is inherently racy against the
        // background persist path + SQLite in-memory connection lifetime
        // in the shared test fixture. The invariant we care about —
        // "partial assistant content is persisted even when the stream
        // aborts before [DONE]" — is the same one that fires on an
        // Azure error chunk: the fake yields some tokens and then an
        // error, the endpoint swallows, and the partial content stays
        // on disk. Deterministic, no disposal races.
        var (userId, token) = await SignupAsync("turn-partial@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("eins", "zwei")
            .QueueError("azure_unavailable", "Dienst abgebrochen.");

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Los" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var events = await ReadSseAsync(response);
        Assert.Contains(events, e => e.Name == "error");

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var loaded = await db.ChatMessages
            .Where(m => m.SessionId == sessionId && m.Role == ChatRole.Assistant)
            .ToListAsync();
        var assistantMessage = Assert.Single(loaded);
        Assert.Equal("einszwei", assistantMessage.Content);
    }

    [Fact]
    public async Task Turn_UmlautContent_RoundTripsAsUtf8()
    {
        var (userId, token) = await SignupAsync("turn-umlaut@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("Spätzle", " mögen", " grün")
            .QueueUsage(5, 3, 0);

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Öl & Soße?" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        var events = await ReadSseAsync(response);

        var tokens = events.Where(e => e.Name == "token")
            .Select(e => JsonDocument.Parse(e.Data).RootElement.GetProperty("text").GetString())
            .ToArray();
        Assert.Contains("Spätzle", tokens);
        Assert.Contains(" mögen", tokens);
        Assert.Contains(" grün", tokens);
    }

    [Fact]
    public async Task Turn_AutoTitle_Triggered_On_First_Turn()
    {
        var (userId, token) = await SignupAsync("turn-title@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("ok")
            .QueueUsage(5, 2, 0)
            .SetTitle("Pasta-Abend");

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Wir kochen Pasta" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        await ReadSseAsync(response);

        // FLAKY-1 — deterministic await on the fire-and-forget title
        // task. The previous poll-with-try/catch raced the background
        // DbContext write against the foreground read on the shared
        // in-memory SQLite connection (SqliteException: database is
        // locked / ObjectDisposedException under test parallelism).
        await _factory.BackgroundTasks.WhenAllAsync();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var s = await db.ChatSessions.FirstOrDefaultAsync(x => x.Id == sessionId);
        Assert.Equal("Pasta-Abend", s?.Title);
    }

    [Fact]
    public async Task Turn_AutoTitle_Skipped_When_SessionAlreadyTitled()
    {
        var (userId, token) = await SignupAsync("turn-alreadytitled@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId, title: "Schon benannt");

        _factory.AzureOpenAi
            .QueueTokens("ok")
            .QueueUsage(5, 2, 0);

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        await ReadSseAsync(response);

        // FLAKY-1 — drain whatever background tasks the turn scheduled
        // (there should be none, because Title is already set). Swapping
        // the old arbitrary Task.Delay(200) for WhenAllAsync keeps the
        // assertion deterministic and zero-cost on the happy path.
        await _factory.BackgroundTasks.WhenAllAsync();

        Assert.Empty(_factory.AzureOpenAi.CompleteCalls);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var s = await db.ChatSessions.SingleAsync(x => x.Id == sessionId);
        Assert.Equal("Schon benannt", s.Title);
    }

    [Fact]
    public async Task Turn_Emits_Error_Event_On_Azure_Error()
    {
        var (userId, token) = await SignupAsync("turn-err@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);

        _factory.AzureOpenAi
            .QueueTokens("bruchstueck")
            .QueueError("azure_unavailable", "Dienst offline.");

        using var req = Authed(HttpMethod.Post, $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);
        var events = await ReadSseAsync(response);

        Assert.Contains(events, e => e.Name == "error");
        Assert.DoesNotContain(events, e => e.Name == "done");
    }

    // ── POST /api/chat/sessions/{id}/to-recipe ─────────────────────

    [Fact]
    public async Task ToRecipe_Anonymous_Gets_401()
    {
        using var req = new HttpRequestMessage(HttpMethod.Post,
            $"/api/chat/sessions/{Guid.NewGuid()}/to-recipe");
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ToRecipe_Unknown_Session_Gets_404()
    {
        var (_, token) = await SignupAsync("rec-404@ex.com", "Chat");
        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{Guid.NewGuid()}/to-recipe", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ToRecipe_CrossUser_Gets_404()
    {
        var (userAId, _) = await SignupAsync("rec-a@ex.com", "A");
        var (_, tokenB) = await SignupAsync("rec-b@ex.com", "B");
        var sessionId = await SeedSessionAsync(userAId);
        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/to-recipe", tokenB);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ToRecipe_Empty_Session_Gets_400()
    {
        var (userId, token) = await SignupAsync("rec-empty@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/to-recipe", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(_factory.ExtractorHandler.Requests);
    }

    [Fact]
    public async Task ToRecipe_Loads_Messages_From_Db_And_Proxies()
    {
        var (userId, token) = await SignupAsync("rec-ok@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        var t0 = _factory.Clock.GetUtcNow();
        await SeedMessageAsync(sessionId, ChatRole.User, "Mach Spätzle daraus.", t0);
        await SeedMessageAsync(sessionId, ChatRole.Assistant, "Mit Käse?", t0.AddSeconds(1));
        await SeedMessageAsync(sessionId, ChatRole.User, "Ja.", t0.AddSeconds(2));

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.OK,
            "{\"title\":\"Spätzle\",\"ingredients\":[],\"steps\":[]}");

        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/to-recipe", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var captured = Assert.Single(_factory.ExtractorHandler.Requests);
        Assert.EndsWith($"/chat/{sessionId:D}/to-recipe", captured.Uri.AbsolutePath);
        Assert.NotNull(captured.Body);
        Assert.Contains("Spätzle", captured.Body);
        Assert.Contains("Mit Käse?", captured.Body);
        // Body is built server-side from DB — no session_id field.
        Assert.DoesNotContain("session_id", captured.Body);
    }

    [Fact]
    public async Task ToRecipe_Persists_ChatUsageLog_With_ChatToRecipe_Kind()
    {
        var (userId, token) = await SignupAsync("rec-usage@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        await SeedMessageAsync(sessionId, ChatRole.User, "Hi", _factory.Clock.GetUtcNow());

        _factory.ExtractorHandler.QueueResponseWithUsage(
            HttpStatusCode.OK,
            "{\"title\":\"X\",\"ingredients\":[],\"steps\":[]}",
            promptTokens: 2000,
            completionTokens: 500,
            cachedPromptTokens: 100,
            model: "gpt-4.1-mini");

        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/to-recipe", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var log = await db.ChatUsageLogs.SingleAsync(c => c.UserId == userId);
        Assert.Equal(ChatUsageKind.ChatToRecipe, log.Kind);
        Assert.Equal(sessionId.ToString("D"), log.SessionId);
        Assert.Equal(2000, log.PromptTokens);
        Assert.Equal("gpt-4.1-mini", log.ModelDeployment);
    }

    // ── CFG-3: feature.chat_enabled kill switch ────────────────────

    /// <summary>Flip <c>feature.chat_enabled</c> to
    /// <paramref name="enabled"/> by upserting the config row directly.
    /// Exercises the real
    /// <see cref="FamilienKochbuch.Api.Services.ExtractorConfigReader"/>
    /// end-to-end against the in-memory SQLite — the same code path
    /// the admin PUT goes through in prod. Upsert (rather than mutate)
    /// because sibling CFG-3 tests that delete the row share the class
    /// fixture's SQLite connection.</summary>
    private async Task SetChatFeatureFlagAsync(bool enabled)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs
            .FirstOrDefaultAsync(c => c.Key == ChatEndpoints.FeatureFlagKey);
        if (row is null)
        {
            db.ExtractorConfigs.Add(new FamilienKochbuch.Domain.Entities.ExtractorConfig(
                ChatEndpoints.FeatureFlagKey,
                enabled ? "true" : "false",
                FamilienKochbuch.Domain.Entities.ExtractorConfigValueType.Bool,
                _factory.Clock.GetUtcNow(),
                updatedBy: null));
        }
        else
        {
            row.UpdateValue(
                enabled ? "true" : "false",
                _factory.Clock.GetUtcNow(),
                updatedBy: null);
        }
        await db.SaveChangesAsync();
    }

    /// <summary>Delete the <c>feature.chat_enabled</c> row entirely so
    /// the reader hits its row-missing fallback branch. Idempotent —
    /// sibling tests may already have deleted it.</summary>
    private async Task DeleteChatFeatureFlagRowAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs
            .FirstOrDefaultAsync(c => c.Key == ChatEndpoints.FeatureFlagKey);
        if (row is not null)
        {
            db.ExtractorConfigs.Remove(row);
            await db.SaveChangesAsync();
        }
    }

    [Fact]
    public async Task CFG3_Turn_Returns_503_When_Feature_Disabled()
    {
        var (userId, token) = await SignupAsync("cfg3-turn-off@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        await SetChatFeatureFlagAsync(enabled: false);

        _factory.AzureOpenAi.QueueTokens("should", " never", " stream");

        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        Assert.Equal("feature_disabled",
            doc.RootElement.GetProperty("code").GetString());
        Assert.Equal("Chat is currently disabled.",
            doc.RootElement.GetProperty("message").GetString());

        // No DB write — user's message must not be persisted.
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            Assert.Equal(0, await db.ChatMessages.CountAsync(m => m.SessionId == sessionId));
        }
        // No Azure call — the fake would record a Complete/Stream call.
        Assert.Empty(_factory.AzureOpenAi.StreamCalls);
    }

    [Fact]
    public async Task CFG3_Turn_Works_When_Feature_Enabled()
    {
        // Explicit true — belt-and-braces that the gate doesn't break
        // the happy path when the seed default is confirmed.
        var (userId, token) = await SignupAsync("cfg3-turn-on@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        await SetChatFeatureFlagAsync(enabled: true);

        _factory.AzureOpenAi
            .QueueTokens("Hallo", "!")
            .QueueUsage(10, 2, 0);

        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var events = await ReadSseAsync(response);
        Assert.Contains(events, e => e.Name == "done");
    }

    [Fact]
    public async Task CFG3_Turn_Row_Missing_Defaults_On()
    {
        var (userId, token) = await SignupAsync("cfg3-turn-missing@ex.com", "Chat");
        var sessionId = await SeedSessionAsync(userId);
        await DeleteChatFeatureFlagRowAsync();

        _factory.AzureOpenAi
            .QueueTokens("ok")
            .QueueUsage(5, 2, 0);

        using var req = Authed(HttpMethod.Post,
            $"/api/chat/sessions/{sessionId}/turn", token);
        req.Content = JsonContent.Create(new { content = "Hi" });
        var response = await _client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    // ── Backward-compat break: POST /api/chat is gone ──────────────

    [Fact]
    public async Task Old_Chat_Endpoint_Returns_404_Or_405()
    {
        // Hard-replaced by the new session surface (CR2).
        var (_, token) = await SignupAsync("old-chat@ex.com", "Chat");
        using var req = Authed(HttpMethod.Post, "/api/chat", token);
        req.Content = JsonContent.Create(new { sessionId = "s", messages = Array.Empty<object>() });
        var response = await _client.SendAsync(req);
        Assert.True(
            response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed
                or HttpStatusCode.BadRequest,
            $"Expected 404/405/400, got {(int)response.StatusCode}");
    }
}
