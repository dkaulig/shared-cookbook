using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Endpoints.MealPlanning;
using FamilienKochbuch.Api.Tests.Infrastructure;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Endpoints.MealPlanning;

/// <summary>
/// Exercises the /api/mealplans/{id}/shopping-list/generate
/// 10/min-per-user rate limit. Must NOT send the
/// X-Test-Disable-RateLimit header so the limiter stays engaged.
/// The limiter partitions on the authenticated user id, so repeat
/// POSTs from the same bearer token share a bucket even though
/// TestServer reports a null RemoteIpAddress.
/// </summary>
public class ShoppingListGenerateRateLimitTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>, IAsyncLifetime
{
    private static readonly DateOnly CurrentMonday = new(2026, 4, 20);

    private readonly FamilienKochbuchWebApplicationFactory _factory;

    public ShoppingListGenerateRateLimitTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        // Clean slate so tests from other classes that seeded users
        // don't pollute the Admin-scoped invite pool.
        await ResetDatabaseAsync();
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private async Task ResetDatabaseAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.ShoppingListItems.RemoveRange(db.ShoppingListItems);
        db.ShoppingLists.RemoveRange(db.ShoppingLists);
        db.MealPlanSlots.RemoveRange(db.MealPlanSlots);
        db.MealPlans.RemoveRange(db.MealPlans);
        db.GroupInvites.RemoveRange(db.GroupInvites);
        db.GroupMemberships.RemoveRange(db.GroupMemberships);
        db.Groups.RemoveRange(db.Groups);
        db.RefreshTokens.RemoveRange(db.RefreshTokens);
        db.AppInvites.RemoveRange(db.AppInvites);
        var nonAdmin = db.Users.Where(u => u.Email != "admin@test.local");
        db.Users.RemoveRange(nonAdmin);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Eleventh_Generate_Call_In_One_Window_Returns_429()
    {
        // Bootstrap: use a rate-limit-bypassing client to run admin
        // chores (invite issue, signup, group + plan creation) so
        // the Generate bucket stays at zero before the real test
        // requests start.
        using var bootstrapClient = _factory.CreateRateLimitBypassingClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
            {
                HandleCookies = true,
            });

        // 1) Admin login → issue app invite.
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

        // 2) Signup fresh user through the bypassing client.
        var signup = await bootstrapClient.PostAsJsonAsync(
            $"/api/auth/signup?token={invite.Token}",
            new AuthEndpoints.SignupRequest("gen.rl@ex.com", "Passwort123!", "RL"));
        signup.EnsureSuccessStatusCode();
        var user = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;

        // 3) Create group + meal plan (still on the bypassing client so
        // the Generate bucket isn't consumed by infra setup).
        bootstrapClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", user.AccessToken);
        var groupRes = await bootstrapClient.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest("Kochbuch", null, null));
        groupRes.EnsureSuccessStatusCode();
        var group = (await groupRes.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        var planRes = await bootstrapClient.PostAsJsonAsync(
            $"/api/groups/{group.Id}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));
        planRes.EnsureSuccessStatusCode();
        var plan = (await planRes.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;

        // 4) Switch to a real (non-bypassing) client so the limiter
        // applies. 10 consecutive generate calls must succeed (they
        // all short-circuit on an empty plan, but each consumes one
        // permit in the "generate" partition keyed by user id).
        using var client = _factory.CreateClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
            {
                HandleCookies = true,
            });
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", user.AccessToken);

        for (var i = 0; i < 10; i++)
        {
            var r = await client.PostAsync(
                $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
            Assert.True(
                r.StatusCode is HttpStatusCode.Created or HttpStatusCode.OK,
                $"Attempt {i + 1}: expected 201/200 but got {(int)r.StatusCode} {r.StatusCode}.");
        }

        // 11th must hit the limiter → 429.
        var throttled = await client.PostAsync(
            $"/api/mealplans/{plan.Id}/shopping-list/generate", null);
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }
}
