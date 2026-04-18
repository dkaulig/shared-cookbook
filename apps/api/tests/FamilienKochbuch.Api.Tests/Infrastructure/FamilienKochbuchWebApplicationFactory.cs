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

    public FakeTimeProvider Clock { get; } =
        new(startDateTime: new DateTimeOffset(2026, 4, 17, 12, 0, 0, TimeSpan.Zero));

    public FakeEmailSender Email { get; } = new();

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
