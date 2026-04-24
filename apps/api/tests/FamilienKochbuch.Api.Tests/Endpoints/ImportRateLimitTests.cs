using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// REL-0b — per-user rate limit on the two import-enqueue endpoints
/// (<c>POST /api/recipes/import/url</c> and
/// <c>POST /api/recipes/import/photos</c>). Policy permits 5 requests
/// per user per sliding minute (see
/// <c>RateLimitPolicies.Import</c> in Program.cs).
///
/// Both endpoints share the same bucket, so a mix of URL + photo
/// imports drains together. The test exercises the URL endpoint
/// because the request fails fast on a malformed URL (400), which
/// still consumes a permit — validates the limiter sits in front of
/// the handler body like every other policy in this project.
///
/// Must NOT send the X-Test-Disable-RateLimit header so the limiter
/// stays engaged.
/// </summary>
public class ImportRateLimitTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;

    public ImportRateLimitTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        await ResetDatabaseAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task ResetDatabaseAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Sixth_UrlImport_Call_In_One_Window_Returns_429()
    {
        // Bootstrap on a bypassing client so signup / invite setup
        // doesn't drain the Import bucket before the actual test loop.
        using var bootstrapClient = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
            {
                HandleCookies = true,
            });

        var adminLogin = await bootstrapClient.PostAsJsonAsync(
            "/api/auth/login",
            new AuthEndpoints.LoginRequest("admin@test.local", "AdminPassword123!"));
        adminLogin.EnsureSuccessStatusCode();
        var adminBody = (await adminLogin.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;
        using var inviteReq = new HttpRequestMessage(HttpMethod.Post, "/api/invites/app/");
        inviteReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", adminBody.AccessToken);
        inviteReq.Content = JsonContent.Create(new { });
        var inviteRes = await bootstrapClient.SendAsync(inviteReq);
        inviteRes.EnsureSuccessStatusCode();
        var invite = (await inviteRes.Content.ReadFromJsonAsync<InviteEndpoints.CreateInviteResponse>())!;

        var signup = await bootstrapClient.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest("import.rl@ex.com", "Passwort123!", "RL"));
        signup.EnsureSuccessStatusCode();
        var user = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;

        // Switch to a non-bypassing client so the limiter applies.
        using var client = _factory.CreateClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
            {
                HandleCookies = true,
            });
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", user.AccessToken);

        // 5 permits. Payload is intentionally malformed (missing URL)
        // so the endpoint short-circuits at the invalid_url guard — but
        // the limiter runs BEFORE the handler so each 400 still drains
        // one permit.
        for (var i = 0; i < 5; i++)
        {
            var r = await client.PostAsJsonAsync(
                "/api/recipes/import/url",
                new { url = "not-a-valid-url", groupId = Guid.Empty });
            Assert.True(
                r.StatusCode is HttpStatusCode.BadRequest,
                $"Attempt {i + 1}: expected 400 but got {(int)r.StatusCode} {r.StatusCode}.");
        }

        var throttled = await client.PostAsJsonAsync(
            "/api/recipes/import/url",
            new { url = "not-a-valid-url", groupId = Guid.Empty });
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }
}
