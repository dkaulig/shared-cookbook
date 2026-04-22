using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints;

/// <summary>
/// COVER-0 — end-to-end tests for <c>GET /api/imports/:id/candidates</c>.
/// Exercises the ownership + gone + not-found branches against a real
/// JWT flow and a SQLite-backed AppDbContext.
/// </summary>
public class ImportCandidatesEndpointTests :
    IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public ImportCandidatesEndpointTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        _factory.Photos.Clear();
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
        db.StagedPhotos.RemoveRange(db.StagedPhotos);
        db.RecipeImports.RemoveRange(db.RecipeImports);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
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

    private async Task<(Guid ImportId, Guid[] CandidateIds)> SeedImportWithCandidatesAsync(
        Guid userId, int candidateCount = 3, bool promoteFirst = false)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var group = new Group("G", null, DateTimeOffset.UtcNow);
        db.Groups.Add(group);
        db.GroupMemberships.Add(new GroupMembership(userId, group.Id, GroupRole.Admin, DateTimeOffset.UtcNow));
        await db.SaveChangesAsync();

        var import = new RecipeImport(
            userId, group.Id, ImportSource.Url,
            "https://example.com/rezept", DateTimeOffset.UtcNow);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync();

        var ids = new List<Guid>();
        for (int i = 0; i < candidateCount; i++)
        {
            var path = $"recipes/cand-{import.Id:N}-{i}.jpg";
            _factory.Photos.Uploads[path] = (new byte[] { 1, 2, 3 }, "image/jpeg");
            var staged = new StagedPhoto(
                userId: userId,
                photoId: path,
                signedUrl: $"/api/photos/{path}?sig=stale&exp=1",
                contentType: "image/jpeg",
                createdAt: DateTimeOffset.UtcNow,
                sourceUrl: $"https://cdn.example/thumb{i}.jpg",
                linkedImportId: import.Id,
                candidateOrder: i);
            if (promoteFirst && i == 0)
                staged.MarkPromoted(Guid.NewGuid(), DateTimeOffset.UtcNow);
            db.StagedPhotos.Add(staged);
            ids.Add(staged.Id);
        }
        await db.SaveChangesAsync();
        return (import.Id, ids.ToArray());
    }

    [Fact]
    public async Task Anonymous_Returns_401()
    {
        var response = await _client.GetAsync($"/api/imports/{Guid.NewGuid()}/candidates");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Missing_Import_Returns_404()
    {
        var (_, token) = await SignupAsync("alice@ex.com", "Alice");
        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/imports/{Guid.NewGuid()}/candidates");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Non_Owner_Returns_403()
    {
        var (aliceId, _) = await SignupAsync("alice@ex.com", "Alice");
        var (_, bobToken) = await SignupAsync("bob@ex.com", "Bob");
        var (importId, _) = await SeedImportWithCandidatesAsync(aliceId);

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/imports/{importId}/candidates");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bobToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Owner_Gets_200_With_Fresh_Signed_Urls()
    {
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var (importId, _) = await SeedImportWithCandidatesAsync(aliceId, candidateCount: 3);

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/imports/{importId}/candidates");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportCandidatesResponse>();
        Assert.NotNull(body);
        Assert.Equal(3, body!.Candidates.Count);
        // Ordered by CandidateOrder ascending.
        Assert.Equal(new[] { 0, 1, 2 }, body.Candidates.Select(c => c.CandidateOrder).ToArray());
        // Freshly signed URLs — the fake storage emits deterministic
        // "sig=fake-sig" tokens rather than the stale stored value.
        Assert.All(body.Candidates, c => Assert.Contains("sig=fake-sig", c.SignedUrl));
        Assert.All(body.Candidates, c => Assert.NotEqual(default, c.ExpiresAt));
    }

    [Fact]
    public async Task All_Promoted_Returns_410()
    {
        // Import exists + caller is the owner + every candidate is
        // already promoted onto a recipe → 410 Gone (rather than
        // 200-with-empty-list) so the frontend can stop polling.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var (importId, ids) = await SeedImportWithCandidatesAsync(
            aliceId, candidateCount: 2, promoteFirst: false);

        // Promote both rows.
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            foreach (var id in ids)
            {
                var row = await db.StagedPhotos.SingleAsync(s => s.Id == id);
                row.MarkPromoted(Guid.NewGuid(), DateTimeOffset.UtcNow);
            }
            await db.SaveChangesAsync();
        }

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/imports/{importId}/candidates");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
    }

    [Fact]
    public async Task Partially_Promoted_Returns_Remaining_Candidates()
    {
        // The "Cover ändern" flow remains usable after the first save:
        // one candidate [0] got promoted onto the recipe, the other two
        // still show up as selectable alternatives.
        var (aliceId, aliceToken) = await SignupAsync("alice@ex.com", "Alice");
        var (importId, _) = await SeedImportWithCandidatesAsync(
            aliceId, candidateCount: 3, promoteFirst: true);

        using var req = new HttpRequestMessage(
            HttpMethod.Get, $"/api/imports/{importId}/candidates");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", aliceToken);
        var response = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ImportEndpoints.ImportCandidatesResponse>();
        Assert.Equal(2, body!.Candidates.Count);
        // Surviving candidates retain their original CandidateOrder;
        // the promoted [0] is just omitted.
        Assert.Equal(new[] { 1, 2 }, body.Candidates.Select(c => c.CandidateOrder).ToArray());
    }
}
