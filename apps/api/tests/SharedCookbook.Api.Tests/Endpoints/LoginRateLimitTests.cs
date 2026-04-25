using System.Net;
using System.Net.Http.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Tests.Infrastructure;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// Exercises the /api/auth/login 5/min per-IP rate limit. Must NOT use the
/// X-Test-Disable-RateLimit header so the limiter stays engaged.
/// </summary>
public class LoginRateLimitTests : IClassFixture<SharedCookbookWebApplicationFactory>
{
    private readonly SharedCookbookWebApplicationFactory _factory;

    public LoginRateLimitTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Sixth_Login_Attempt_In_One_Window_Returns_429()
    {
        using var client = _factory.CreateClient();
        var creds = new AuthEndpoints.LoginRequest("anyone@example.com", "not-the-password");

        // 5 attempts all fail auth (401) but consume permits.
        for (var i = 0; i < 5; i++)
        {
            var r = await client.PostAsJsonAsync("/api/auth/login", creds);
            Assert.Equal(HttpStatusCode.Unauthorized, r.StatusCode);
        }

        // 6th must be 429.
        var throttled = await client.PostAsJsonAsync("/api/auth/login", creds);
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }
}
