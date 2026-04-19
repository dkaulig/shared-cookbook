using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end tests for the P2-6 chat bridge endpoints
/// <c>POST /api/chat</c> and <c>POST /api/chat/{sessionId}/to-recipe</c>.
/// These are synchronous proxies: the .NET endpoint forwards the body
/// (re-serialised) to the Python extractor with the HMAC signer
/// applied, then maps the Python response back to the caller via the
/// P2-6 error-code translation policy.
///
/// The tests drive the test HttpMessageHandler (see
/// <see cref="TestExtractorHandler"/>) so no real Python service is
/// needed. Assertions cover: HMAC headers go out; happy path carries
/// the response through; each Python status code maps to the right
/// .NET status + German copy.
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
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.ExtractorHandler.Reset();
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
        db.ChatUsageLogs.RemoveRange(db.ChatUsageLogs);
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    private async Task<(Guid userId, string token)> SignupAsync(string email, string displayName)
    {
        var adminToken = (await LoginAsync("admin@test.local", "AdminPassword123!")).AccessToken;
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminToken);
        req.Content = JsonContent.Create(new { });
        var inviteRes = await _client.SendAsync(req);
        inviteRes.EnsureSuccessStatusCode();
        var invite = await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>();

        using var fresh = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var signup = await fresh.PostAsJsonAsync(
            $"/api/auth/signup?token={invite!.Token}",
            new AuthEndpoints.SignupRequest(email, "Passwort123!", displayName));
        signup.EnsureSuccessStatusCode();
        var body = await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        return (body!.User.Id, body.AccessToken);
    }

    private async Task<AuthEndpoints.AuthResponse> LoginAsync(string email, string password)
    {
        using var client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest(email, password));
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
    }

    // ── Request bodies used by the bridge ─────────────────────────────

    public sealed record ChatMessageDto(string Role, string Content);
    public sealed record ChatTurnRequest(string SessionId, ChatMessageDto[] Messages);
    public sealed record ChatTurnResponse(string AssistantMessage);
    public sealed record ChatToRecipeRequest(ChatMessageDto[] Messages);

    // ── POST /api/chat ───────────────────────────────────────────────

    [Fact]
    public async Task Chat_Anonymous_Gets_401()
    {
        var body = new ChatTurnRequest(
            "session-1",
            new[] { new ChatMessageDto("user", "Hallo") });
        var response = await _client.PostAsJsonAsync("/api/chat", body);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Chat_Happy_Path_Proxies_With_HMAC_Headers()
    {
        var (userId, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.OK,
            "{\"assistant_message\":\"Was willst du kochen?\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "session-xyz",
            new[] { new ChatMessageDto("user", "Ich habe Spinat übrig.") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            "Was willst du kochen?",
            body.GetProperty("assistant_message").GetString());

        // Python got exactly one signed request.
        var captured = Assert.Single(_factory.ExtractorHandler.Requests);
        Assert.Equal(HttpMethod.Post, captured.Method);
        Assert.EndsWith("/chat", captured.Uri.AbsolutePath);
        Assert.True(captured.Headers.ContainsKey(ExtractorHmacSigner.SignatureHeader));
        Assert.True(captured.Headers.ContainsKey(ExtractorHmacSigner.TimestampHeader));
        Assert.Equal(userId.ToString("D"), captured.Headers[ExtractorHmacSigner.UserIdHeader]);

        // The body passed through with the right shape (re-serialised,
        // so snake_case + the validated messages list are both present).
        Assert.NotNull(captured.Body);
        Assert.Contains("\"session_id\":\"session-xyz\"", captured.Body);
        Assert.Contains("\"messages\"", captured.Body);
        Assert.Contains("Spinat", captured.Body);
    }

    [Fact]
    public async Task Chat_Happy_Path_Persists_Usage_Log_Row()
    {
        var (userId, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponseWithUsage(
            HttpStatusCode.OK,
            "{\"assistant_message\":\"ok\"}",
            promptTokens: 555,
            completionTokens: 222,
            cachedPromptTokens: 100,
            model: "gpt-5.1-chat");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "sess-usage-1",
            new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var log = await db.ChatUsageLogs.SingleAsync(c => c.UserId == userId);
        Assert.Equal("sess-usage-1", log.SessionId);
        Assert.Equal(Domain.Entities.ChatUsageKind.ChatTurn, log.Kind);
        Assert.Equal(555, log.PromptTokens);
        Assert.Equal(222, log.CompletionTokens);
        Assert.Equal(100, log.CachedPromptTokens);
        Assert.Equal("gpt-5.1-chat", log.ModelDeployment);
    }

    [Fact]
    public async Task Chat_Happy_Path_Without_Usage_Headers_Skips_Log()
    {
        // When Python doesn't supply the X-Extractor-* headers (mock
        // provider in an old deploy, etc.) the proxy must still return
        // 200 + the reply, but skip the ChatUsageLog insert.
        var (userId, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.OK, "{\"assistant_message\":\"ok\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "sess-no-usage",
            new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Empty(db.ChatUsageLogs.Where(c => c.UserId == userId));
    }

    [Fact]
    public async Task Chat_Python_503_Maps_To_503_With_German_Copy()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.ServiceUnavailable,
            "{\"detail\":\"KI-Service momentan nicht erreichbar. Bitte später erneut versuchen.\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var message = body.GetProperty("message").GetString()!;
        Assert.Contains("KI-Service", message);
        Assert.Contains("nicht erreichbar", message);
    }

    [Fact]
    public async Task Chat_Python_400_Maps_To_400_With_Message()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.BadRequest,
            "{\"detail\":\"Nachrichtenliste darf nicht leer sein.\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(
            "Nachrichtenliste darf nicht leer sein.",
            body.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Chat_Python_413_Maps_To_413()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.RequestEntityTooLarge,
            "{\"detail\":\"Dialog überschreitet die Größenbeschränkung.\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
    }

    [Fact]
    public async Task Chat_Python_422_Maps_To_400()
    {
        // Python uses 422 for validation errors (invalid schema / shape).
        // .NET prefers 400 for the same semantic — the error mapper
        // collapses the two. Test pins the translation so a future
        // refactor can't silently change the caller-visible status.
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.UnprocessableEntity,
            "{\"detail\":\"session_id darf nicht leer sein.\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Chat_Transport_Failure_Maps_To_502()
    {
        // The Python service unreachable (connection refused, timeout,
        // DNS failure, etc.) must surface as 502 Bad Gateway to the
        // caller — distinct from a provider outage (503) since the
        // failure is between .NET and the extractor, not between the
        // extractor and Azure. Pins the PythonProxyErrorMapper transport
        // branch.
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponder(_ =>
            throw new HttpRequestException("connection refused"));

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
    }

    [Fact]
    public async Task Chat_Python_401_Is_Masked_As_500()
    {
        // HMAC mismatch on the wire must not leak to the caller — it
        // means our signer + Python's verifier disagree, which is an
        // internal server error.
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.Unauthorized,
            "{\"detail\":\"invalid signature\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        var msg = body.GetProperty("message").GetString();
        Assert.DoesNotContain("signature", msg!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Chat_Rejects_Empty_Messages_Without_Hitting_Python()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1", Array.Empty<ChatMessageDto>()));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(_factory.ExtractorHandler.Requests);
    }

    [Fact]
    public async Task Chat_Rejects_Unknown_Role_Without_Hitting_Python()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/chat");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatTurnRequest(
            "s1",
            new[] { new ChatMessageDto("system-admin", "drop all tables") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(_factory.ExtractorHandler.Requests);
    }

    // ── POST /api/chat/{sessionId}/to-recipe ─────────────────────────

    [Fact]
    public async Task ChatToRecipe_Happy_Path_Proxies_With_Path_Session_Id()
    {
        var (userId, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.OK,
            "{\"title\":\"Spätzle\",\"ingredients\":[],\"steps\":[]}");

        using var req = new HttpRequestMessage(HttpMethod.Post,
            "/api/chat/sess-42/to-recipe");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatToRecipeRequest(
            new[] { new ChatMessageDto("user", "Mach Spätzle daraus.") }));

        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Spätzle", body.GetProperty("title").GetString());

        var captured = Assert.Single(_factory.ExtractorHandler.Requests);
        Assert.Equal(HttpMethod.Post, captured.Method);
        Assert.EndsWith("/chat/sess-42/to-recipe", captured.Uri.AbsolutePath);
        Assert.Equal(userId.ToString("D"), captured.Headers[ExtractorHmacSigner.UserIdHeader]);
        Assert.NotNull(captured.Body);
        Assert.Contains("Spätzle", captured.Body);
        // The body forwarded only the messages (the session id lives
        // in the path, not the body).
        Assert.DoesNotContain("session_id", captured.Body);
    }

    [Fact]
    public async Task ChatToRecipe_Happy_Path_Persists_Usage_Log_With_ChatToRecipe_Kind()
    {
        var (userId, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponseWithUsage(
            HttpStatusCode.OK,
            "{\"title\":\"Spätzle\",\"ingredients\":[],\"steps\":[]}",
            promptTokens: 2000,
            completionTokens: 450,
            cachedPromptTokens: 0,
            model: "gpt-5.1");

        using var req = new HttpRequestMessage(HttpMethod.Post,
            "/api/chat/sess-42/to-recipe");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatToRecipeRequest(
            new[] { new ChatMessageDto("user", "Mach ein Rezept.") }));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var log = await db.ChatUsageLogs.SingleAsync(c => c.UserId == userId);
        Assert.Equal(Domain.Entities.ChatUsageKind.ChatToRecipe, log.Kind);
        Assert.Equal("sess-42", log.SessionId);
        Assert.Equal(2000, log.PromptTokens);
        Assert.Equal("gpt-5.1", log.ModelDeployment);
    }

    [Fact]
    public async Task ChatToRecipe_Anonymous_Gets_401()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/chat/sess-1/to-recipe",
            new ChatToRecipeRequest(new[] { new ChatMessageDto("user", "Hi") }));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task ChatToRecipe_Rejects_Empty_Messages()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        using var req = new HttpRequestMessage(HttpMethod.Post,
            "/api/chat/sess-1/to-recipe");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatToRecipeRequest(
            Array.Empty<ChatMessageDto>()));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(_factory.ExtractorHandler.Requests);
    }

    [Fact]
    public async Task ChatToRecipe_Python_503_Maps_To_503()
    {
        var (_, token) = await SignupAsync("chatter@ex.com", "Chat");

        _factory.ExtractorHandler.QueueResponse(
            HttpStatusCode.ServiceUnavailable,
            "{\"detail\":\"KI-Service momentan nicht erreichbar.\"}");

        using var req = new HttpRequestMessage(HttpMethod.Post,
            "/api/chat/sess-1/to-recipe");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new ChatToRecipeRequest(
            new[] { new ChatMessageDto("user", "Hi") }));

        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }
}
