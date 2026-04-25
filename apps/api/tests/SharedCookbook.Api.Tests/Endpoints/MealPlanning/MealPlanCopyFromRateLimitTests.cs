using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Endpoints.MealPlanning;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.MealPlanning;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints.MealPlanning;

/// <summary>
/// Exercises the /api/mealplans/{id}/copy-from/{sourceWeekStart}
/// 10/min-per-user rate limit. Must NOT send the
/// X-Test-Disable-RateLimit header so the limiter stays engaged.
/// Reuses the existing Generate policy (see Program.cs) — same
/// partition bucket, so repeat POSTs from the same bearer token
/// share a bucket even though TestServer reports a null
/// RemoteIpAddress.
///
/// Each "success" call trips the empty-target guard (the target
/// gets a slot from the first copy), so requests 2..10 return 409
/// Conflict. Both 2xx AND 409 consume one permit each — that's
/// the correct model for a rate limit that wants to blunt
/// runaway-click loops, since the server work is already done
/// before we decide how to respond. The 11th still hits 429.
/// </summary>
public class MealPlanCopyFromRateLimitTests
    : IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private static readonly DateOnly CurrentMonday = new(2026, 4, 20);
    private static readonly DateOnly PreviousMonday = new(2026, 4, 13);

    private readonly SharedCookbookWebApplicationFactory _factory;

    public MealPlanCopyFromRateLimitTests(SharedCookbookWebApplicationFactory factory)
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
    public async Task Eleventh_CopyFrom_Call_In_One_Window_Returns_429()
    {
        // Bootstrap on a bypassing client so setup calls don't drain
        // the Generate bucket before the real test requests start.
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
            new AuthEndpoints.SignupRequest("copyfrom.rl@ex.com", "Passwort123!", "RL"));
        signup.EnsureSuccessStatusCode();
        var user = (await signup.Content.ReadFromJsonAsync<AuthEndpoints.AuthResponse>())!;

        bootstrapClient.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", user.AccessToken);
        var groupRes = await bootstrapClient.PostAsJsonAsync(
            "/api/groups",
            new GroupEndpoints.CreateGroupRequest("Kochbuch", null, null));
        groupRes.EnsureSuccessStatusCode();
        var group = (await groupRes.Content.ReadFromJsonAsync<GroupEndpoints.GroupSummaryDto>())!;
        // Source plan + one slot so the first copy has something to
        // copy. Subsequent copies trip the empty-target guard (target
        // now has 1 slot from the first successful copy).
        var sourceRes = await bootstrapClient.PostAsJsonAsync(
            $"/api/groups/{group.Id}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(PreviousMonday));
        sourceRes.EnsureSuccessStatusCode();
        var source = (await sourceRes.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;
        var slotRes = await bootstrapClient.PostAsJsonAsync(
            $"/api/mealplans/{source.Id}/slots",
            new MealPlanEndpoints.AddSlotRequest(
                RecipeId: null,
                Label: "Nudelsuppe",
                Date: PreviousMonday,
                Meal: MealSlot.Mittag,
                Servings: 2));
        slotRes.EnsureSuccessStatusCode();
        var targetRes = await bootstrapClient.PostAsJsonAsync(
            $"/api/groups/{group.Id}/mealplans",
            new MealPlanEndpoints.CreateMealPlanRequest(CurrentMonday));
        targetRes.EnsureSuccessStatusCode();
        var target = (await targetRes.Content.ReadFromJsonAsync<MealPlanEndpoints.MealPlanDto>())!;

        // Switch to a non-bypassing client so the limiter applies.
        using var client = _factory.CreateClient(
            new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
            {
                HandleCookies = true,
            });
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", user.AccessToken);

        // 10 permits: first returns 200, the next 9 return 409 (target
        // no longer empty). Both outcomes consume one permit each.
        for (var i = 0; i < 10; i++)
        {
            var r = await client.PostAsync(
                $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);
            Assert.True(
                r.StatusCode is HttpStatusCode.OK or HttpStatusCode.Conflict,
                $"Attempt {i + 1}: expected 200/409 but got {(int)r.StatusCode} {r.StatusCode}.");
        }

        // 11th must hit the limiter → 429.
        var throttled = await client.PostAsync(
            $"/api/mealplans/{target.Id}/copy-from/{PreviousMonday:yyyy-MM-dd}", null);
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }
}
