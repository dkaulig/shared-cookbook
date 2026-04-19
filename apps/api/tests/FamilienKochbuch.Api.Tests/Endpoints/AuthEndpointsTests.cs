using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// End-to-end integration tests for the /api/auth endpoints.
/// Runs against the real DI graph with the SQLite-backed test factory.
/// </summary>
public class AuthEndpointsTests : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public AuthEndpointsTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        _factory.Email.Clear();
        await ResetDatabaseAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetDatabaseAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var admins = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(admins);
        await db.SaveChangesAsync();
        // Ensure at least one invite exists for signup happy-path tests.
    }

    private async Task<AppInvite> CreateInviteAsync(
        DateTimeOffset? expiresAt = null,
        bool alreadyUsed = false)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Any existing user works as the creator — ensure the admin is present.
        var admin = await db.Users.FirstAsync();

        var now = _factory.Clock.GetUtcNow();
        var invite = new AppInvite(
            token: InviteEndpoints.GenerateToken(),
            createdByUserId: admin.Id,
            email: null,
            createdAt: now,
            expiresAt: expiresAt ?? now.AddDays(14));
        if (alreadyUsed)
            invite.MarkUsed(admin.Id, now);

        db.AppInvites.Add(invite);
        await db.SaveChangesAsync();
        return invite;
    }

    // ── SIGNUP ──────────────────────────────────────────────────────

    [Fact]
    public async Task Signup_With_Valid_Invite_Returns_Access_Token_And_Sets_Cookie()
    {
        var invite = await CreateInviteAsync();

        var response = await _client.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest("new.user@example.com", "Passwort123!", "Neuer Nutzer"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        Assert.NotNull(body);
        Assert.False(string.IsNullOrWhiteSpace(body!.AccessToken));
        Assert.Equal("new.user@example.com", body.User.Email);
        Assert.Equal("Neuer Nutzer", body.User.DisplayName);
        Assert.Equal("User", body.User.Role);

        Assert.Contains(response.Headers.GetValues("Set-Cookie"), c => c.StartsWith("fk_refresh=", StringComparison.Ordinal));

        // DB side-effects: invite marked used, user exists, refresh-token row created.
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var reloaded = await db.AppInvites.SingleAsync(i => i.Id == invite.Id);
        Assert.NotNull(reloaded.UsedByUserId);
        Assert.True(await db.Users.AnyAsync(u => u.Email == "new.user@example.com"));
        Assert.Equal(1, await db.RefreshTokens.CountAsync(r => r.UserId == body.User.Id));
    }

    [Fact]
    public async Task Signup_With_Unknown_Token_Returns_400()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/auth/signup?token=not-a-real-token-that-does-not-exist-in-db-anywhere-at-all-nope",
            new AuthEndpoints.SignupRequest("x@example.com", "Passwort123!", "X"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.NotNull(body);
        Assert.Equal("invite_not_found", body!.Code);
    }

    [Fact]
    public async Task Signup_With_Expired_Invite_Returns_400()
    {
        var now = _factory.Clock.GetUtcNow();
        var invite = await CreateInviteAsync(expiresAt: now.AddMinutes(1));
        _factory.Clock.Advance(TimeSpan.FromMinutes(10));

        var response = await _client.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest("x@example.com", "Passwort123!", "X"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invite_invalid", body!.Code);
    }

    [Fact]
    public async Task Signup_With_Already_Used_Invite_Returns_400()
    {
        var invite = await CreateInviteAsync(alreadyUsed: true);

        var response = await _client.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest("x@example.com", "Passwort123!", "X"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<FamilienKochbuch.Api.Services.ErrorResponse>();
        Assert.Equal("invite_invalid", body!.Code);
    }

    // ── LOGIN ───────────────────────────────────────────────────────

    [Fact]
    public async Task Login_With_Correct_Password_Returns_Access_Token()
    {
        await SeedUserAsync("user@example.com", "Passwort123!");

        var response = await _client.PostAsJsonAsync(
            "/api/auth/login",
            new AuthEndpoints.LoginRequest("user@example.com", "Passwort123!"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        Assert.False(string.IsNullOrWhiteSpace(body!.AccessToken));
        Assert.Contains(response.Headers.GetValues("Set-Cookie"), c => c.StartsWith("fk_refresh=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Login_With_Wrong_Password_Returns_401()
    {
        await SeedUserAsync("user2@example.com", "Correct123!");

        var response = await _client.PostAsJsonAsync(
            "/api/auth/login",
            new AuthEndpoints.LoginRequest("user2@example.com", "Wrong123!"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Login_With_Unknown_Email_Returns_401()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/auth/login",
            new AuthEndpoints.LoginRequest("no-such-user@example.com", "whatever"));

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── REFRESH ─────────────────────────────────────────────────────

    [Fact]
    public async Task Refresh_With_Valid_Cookie_Rotates_And_Returns_New_Access_Token()
    {
        await SeedUserAsync("refresh@example.com", "Passwort123!");
        var login = await _client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("refresh@example.com", "Passwort123!"));
        login.EnsureSuccessStatusCode();
        var firstBody = await login.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();

        _factory.Clock.Advance(TimeSpan.FromMinutes(5));

        var refresh = await _client.PostAsync("/api/auth/refresh", content: null);
        Assert.Equal(HttpStatusCode.OK, refresh.StatusCode);

        var body = await refresh.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();
        Assert.NotNull(body);
        Assert.NotEqual(firstBody!.AccessToken, body!.AccessToken);
        Assert.Contains(refresh.Headers.GetValues("Set-Cookie"), c => c.StartsWith("fk_refresh=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Refresh_With_Reused_Old_Cookie_Returns_401_And_Revokes_Family()
    {
        await SeedUserAsync("reuse@example.com", "Passwort123!");
        var clientOpts = new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        };
        using var clientA = _factory.CreateRateLimitBypassingClient(clientOpts);
        var login = await clientA.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("reuse@example.com", "Passwort123!"));
        login.EnsureSuccessStatusCode();

        // Capture the first Set-Cookie value so we can replay it later.
        var setCookie = login.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("fk_refresh=", StringComparison.Ordinal));
        var capturedRefresh = setCookie.Split(';')[0].Substring("fk_refresh=".Length);
        Assert.False(string.IsNullOrEmpty(capturedRefresh));

        _factory.Clock.Advance(TimeSpan.FromMinutes(1));

        // Legitimate rotation (this replaces the captured token, so the victim's
        // clientA now has the successor cookie).
        var rotated = await clientA.PostAsync("/api/auth/refresh", content: null);
        rotated.EnsureSuccessStatusCode();

        _factory.Clock.Advance(TimeSpan.FromMinutes(1));

        // Attacker replay — sends the OLD cookie value verbatim.
        using var attacker = _factory.CreateRateLimitBypassingClient();
        var replay = new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh");
        replay.Headers.Add("Cookie", $"fk_refresh={capturedRefresh}");
        var reuseResponse = await attacker.SendAsync(replay);
        Assert.Equal(HttpStatusCode.Unauthorized, reuseResponse.StatusCode);

        // Family must be fully revoked now — even the victim's rotation cookie
        // should be rejected.
        var afterReuse = await clientA.PostAsync("/api/auth/refresh", content: null);
        Assert.Equal(HttpStatusCode.Unauthorized, afterReuse.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var user = await db.Users.SingleAsync(u => u.Email == "reuse@example.com");
        var active = await db.RefreshTokens.CountAsync(r => r.UserId == user.Id && r.RevokedAt == null);
        Assert.Equal(0, active);
    }

    [Fact]
    public async Task Refresh_Without_Cookie_Returns_401()
    {
        using var client = _factory.CreateRateLimitBypassingClient();
        var response = await client.PostAsync("/api/auth/refresh", content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── LOGOUT ──────────────────────────────────────────────────────

    [Fact]
    public async Task Logout_Clears_Cookie_And_Revokes_Refresh_Token()
    {
        await SeedUserAsync("logout@example.com", "Passwort123!");
        var login = await _client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("logout@example.com", "Passwort123!"));
        var loginBody = await login.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>();

        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", loginBody!.AccessToken);
        var logout = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var active = await db.RefreshTokens.CountAsync(r => r.UserId == loginBody.User.Id && r.RevokedAt == null);
        Assert.Equal(0, active);
    }

    // ── PASSWORD RESET ──────────────────────────────────────────────

    [Fact]
    public async Task PasswordResetRequest_Returns_204_And_Sends_Email_For_Known_User()
    {
        await SeedUserAsync("reset@example.com", "AltesPasswort1!");

        var response = await _client.PostAsJsonAsync(
            "/api/auth/password-reset-request",
            new AuthEndpoints.PasswordResetRequestBody("reset@example.com"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Single(_factory.Email.Messages);
        Assert.Equal("reset@example.com", _factory.Email.Last!.ToEmail);
    }

    [Fact]
    public async Task PasswordResetRequest_Returns_204_And_No_Email_For_Unknown_User()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/auth/password-reset-request",
            new AuthEndpoints.PasswordResetRequestBody("nobody@example.com"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(_factory.Email.Messages);
    }

    [Fact]
    public async Task PasswordResetRequest_Returns_204_When_Mail_Delivery_Fails()
    {
        // If SMTP is down a 5xx would leak account existence (200 = no
        // account, 500 = account exists + SMTP broken). The endpoint must
        // stay uniformly 204 regardless of mail failure.
        await SeedUserAsync("reset-fail@example.com", "AltesPasswort1!");
        _factory.Email.ThrowOnSend = new EmailSendException("simulated SMTP failure");

        var response = await _client.PostAsJsonAsync(
            "/api/auth/password-reset-request",
            new AuthEndpoints.PasswordResetRequestBody("reset-fail@example.com"));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Empty(_factory.Email.Messages);
    }

    [Fact]
    public async Task PasswordReset_With_Captured_Token_Updates_Password()
    {
        await SeedUserAsync("reset2@example.com", "AltesPasswort1!");
        await _client.PostAsJsonAsync(
            "/api/auth/password-reset-request",
            new AuthEndpoints.PasswordResetRequestBody("reset2@example.com"));
        var resetMessage = _factory.Email.Last!;

        // The URL is .../reset-password?token=URL-ENCODED(userId|rawToken).
        var token = System.Web.HttpUtility.ParseQueryString(new Uri(resetMessage.ResetUrl).Query)["token"]!;

        var reset = await _client.PostAsJsonAsync(
            "/api/auth/password-reset",
            new AuthEndpoints.PasswordResetBody(token, "NeuesPasswort1!"));

        Assert.Equal(HttpStatusCode.NoContent, reset.StatusCode);

        // Old password stops working.
        var wrongPw = await _client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("reset2@example.com", "AltesPasswort1!"));
        Assert.Equal(HttpStatusCode.Unauthorized, wrongPw.StatusCode);

        // New password works.
        var rightPw = await _client.PostAsJsonAsync("/api/auth/login",
            new AuthEndpoints.LoginRequest("reset2@example.com", "NeuesPasswort1!"));
        Assert.Equal(HttpStatusCode.OK, rightPw.StatusCode);
    }

    // ── helpers ─────────────────────────────────────────────────────

    private async Task SeedUserAsync(string email, string password)
    {
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<Microsoft.AspNetCore.Identity.UserManager<User>>();
        var user = new User();
        user.SetEmail(email);
        user.SetDisplayName(email.Split('@')[0]);
        user.EmailConfirmed = true;
        var result = await users.CreateAsync(user, password);
        if (!result.Succeeded)
            throw new InvalidOperationException("Seeding failed: " + string.Join(", ", result.Errors.Select(e => e.Description)));
    }
}
