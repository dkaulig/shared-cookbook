namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Liveness endpoint used by the reverse proxy, docker-compose healthcheck, and smoke tests.
/// Intentionally dependency-free so it answers even while infrastructure is warming up.
/// </summary>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/health", () => Results.Ok(new HealthResponse(
            Status: "ok",
            Timestamp: DateTimeOffset.UtcNow.ToString("o"))));

        return app;
    }

    /// <summary>
    /// Payload returned by <c>GET /api/health</c>. Shape is mirrored by the
    /// TypeScript <c>HealthResponse</c> type in <c>@familien-kochbuch/shared</c>.
    /// </summary>
    public sealed record HealthResponse(string Status, string Timestamp);
}
