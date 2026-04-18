using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Infrastructure;

/// <summary>
/// Test-host factory — swaps Postgres for an in-memory SQLite connection
/// and wires a <see cref="FakeTimeProvider"/> + spy <see cref="IEmailSender"/>
/// so integration tests stay fast, hermetic, and deterministic. Mirrors
/// the hoppr pattern (<c>HopprWebApplicationFactory</c>).
/// </summary>
public class FamilienKochbuchWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private SqliteConnection? _connection;

    // Seed at real "now" so JwtBearer's lifetime validation (which runs
    // against real system time and cannot be intercepted via TimeProvider)
    // still sees non-expired tokens. FakeTimeProvider advances drive the
    // rotation/expiry assertions forward explicitly via Clock.Advance().
    public FakeTimeProvider Clock { get; } = new(startDateTime: DateTimeOffset.UtcNow);

    public FakeEmailSender Email { get; } = new();

    public FakePhotoStorage Photos { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("Jwt:SigningKey", "integration-test-signing-key-definitely-long-enough-32chars!");
        builder.UseSetting("Jwt:Issuer", "familien-kochbuch-test");
        builder.UseSetting("Jwt:Audience", "familien-kochbuch-web-test");
        builder.UseSetting("Jwt:AccessTokenLifetimeMinutes", "15");
        builder.UseSetting("Jwt:RefreshTokenLifetimeDays", "30");
        builder.UseSetting("App:FrontendBaseUrl", "http://localhost");
        builder.UseSetting("ADMIN_EMAIL", "admin@test.local");
        builder.UseSetting("ADMIN_PASSWORD", "AdminPassword123!");
        // BF1 #2 — pin a person-shaped display name so revision-author
        // assertions can exercise the projection without colliding with
        // the legacy "Admin" role-label default.
        builder.UseSetting("ADMIN_DISPLAY_NAME", "Test Familie");

        builder.ConfigureServices(services =>
        {
            // Program.cs skips its Postgres DbContext registration when the
            // environment is Testing — we own the DbContext wiring here.
            _connection ??= new SqliteConnection("DataSource=:memory:");
            if (_connection.State != System.Data.ConnectionState.Open)
                _connection.Open();

            services.AddDbContext<AppDbContext>(opts => opts.UseSqlite(_connection));

            // Deterministic clock.
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);

            // Spy email sender so password-reset tests can capture the outgoing URL.
            services.RemoveAll<IEmailSender>();
            services.AddSingleton<IEmailSender>(Email);

            // Hermetic photo storage — no SeaweedFS required.
            services.RemoveAll<IPhotoStorage>();
            services.AddSingleton<IPhotoStorage>(Photos);
        });
    }

    public async Task InitializeAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.EnsureCreatedAsync();
        var seeder = scope.ServiceProvider.GetRequiredService<SeedDataService>();
        await seeder.SeedAsync();
    }

    /// <summary>
    /// Creates a client with the per-test rate-limit disable header set.
    /// Tests that specifically exercise the rate limiter should call
    /// <see cref="WebApplicationFactory{TEntryPoint}.CreateClient()"/> directly.
    /// </summary>
    public HttpClient CreateRateLimitBypassingClient(
        Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions? options = null)
    {
        var client = options is null ? CreateClient() : CreateClient(options);
        client.DefaultRequestHeaders.Add("X-Test-Disable-RateLimit", "true");
        return client;
    }

    public new async Task DisposeAsync()
    {
        if (_connection is not null)
        {
            await _connection.DisposeAsync();
            _connection = null;
        }
        await base.DisposeAsync();
    }
}

internal static class ServiceCollectionExtensions
{
    public static void RemoveAll<T>(this IServiceCollection services)
    {
        var descriptors = services.Where(d => d.ServiceType == typeof(T)).ToList();
        foreach (var d in descriptors) services.Remove(d);
    }
}
