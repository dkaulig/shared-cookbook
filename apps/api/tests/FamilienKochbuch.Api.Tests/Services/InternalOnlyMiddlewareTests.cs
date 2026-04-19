using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Api.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// PV1 — app-level defence-in-depth for <c>/api/internal/*</c>. Caddy's
/// <c>@internal</c> matcher is defence layer 1 (verified manually by
/// config-parse checks in CI); this suite pins the behaviour of layer 2,
/// <see cref="InternalOnlyMiddleware"/>, independently.
///
/// The TestServer's synthetic transport leaves
/// <c>Context.Connection.RemoteIpAddress</c> as <c>null</c>, which the
/// middleware treats as "not proven internal" → 404. That shape
/// matches the production "external origin detected" path because both
/// fail-closed into the same 404 mask.
/// </summary>
public class InternalOnlyMiddlewareTests
    : IClassFixture<FamilienKochbuchWebApplicationFactory>
{
    private readonly FamilienKochbuchWebApplicationFactory _factory;

    public InternalOnlyMiddlewareTests(FamilienKochbuchWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task External_Origin_Receives_404()
    {
        // No X-Test-Internal-Allow header → middleware runs normally →
        // synthetic null RemoteIpAddress → deny 404.
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-Forwarded-For", "203.0.113.42");

        var res = await client.PostAsJsonAsync(
            $"/api/internal/imports/{Guid.NewGuid()}/progress",
            new { phase = "downloading", phase_progress = 10, attempt = 1 });

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task External_Origin_With_Bearer_Still_Returns_404()
    {
        // Layer-2 reject must happen before auth so a caller with a
        // valid token still gets 404 from outside — the token never
        // even gets inspected. This pins the "no information leakage"
        // promise.
        using var client = _factory.CreateClient();
        var tokens = _factory.Services.GetRequiredService<ImportProgressTokenService>();
        var importId = Guid.NewGuid();
        var token = tokens.Sign(importId, _factory.Clock.GetUtcNow().AddMinutes(5));

        var req = new HttpRequestMessage(
            HttpMethod.Post, $"/api/internal/imports/{importId}/progress");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Content = JsonContent.Create(new { phase = "downloading", phase_progress = 10, attempt = 1 });
        var res = await client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Non_Internal_Path_Is_Passed_Through()
    {
        // The middleware must not interfere with any other route; a
        // health check continues to serve 200 even without the bypass
        // header.
        using var client = _factory.CreateClient();
        var res = await client.GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Test_Bypass_Header_Allows_Internal_Path()
    {
        // Sanity-check the opt-in: with the header set, the middleware
        // lets the request reach the endpoint (which then returns 401
        // because no token was supplied — proof the middleware allowed
        // the request through rather than short-circuiting with 404).
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Add(InternalOnlyMiddleware.TestBypassHeader, "true");

        var res = await client.PostAsJsonAsync(
            $"/api/internal/imports/{Guid.NewGuid()}/progress",
            new { phase = "downloading", phase_progress = 10, attempt = 1 });

        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }
}
