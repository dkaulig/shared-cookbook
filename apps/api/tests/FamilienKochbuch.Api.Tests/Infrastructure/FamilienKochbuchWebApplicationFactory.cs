using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
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

    /// <summary>PF3 — when <c>true</c>, skip the default
    /// FakeEmailSender override so the production conditional
    /// registration (NoOpEmailSender vs SmtpEmailSender) is exercised.</summary>
    private bool _skipFakeEmailSender;

    /// <summary>PF3 — overrides for the Smtp config section, letting
    /// registration tests flip between populated / empty values.</summary>
    private string? _smtpHost;
    private string? _smtpFromAddress;
    private int? _smtpPort;
    private bool? _smtpUseStartTls;

    /// <summary>
    /// Captures every HTTP request sent through the named
    /// <see cref="ExtractRecipeFromUrlJob.HttpClientName"/> client so the
    /// P2-6 bridge endpoint tests can assert HMAC headers / body shape
    /// and replay scripted Python responses without a live service.
    /// </summary>
    public TestExtractorHandler ExtractorHandler { get; } = new();

    /// <summary>
    /// Captures every job enqueue so the P2-6 URL + Photos import
    /// endpoint tests can assert the right job type + importId without
    /// spinning up a real Hangfire server.
    /// </summary>
    public CapturingBackgroundJobClient Jobs { get; } = new();

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

        if (_smtpHost is not null)
            builder.UseSetting("Smtp:Host", _smtpHost);
        if (_smtpFromAddress is not null)
            builder.UseSetting("Smtp:FromAddress", _smtpFromAddress);
        if (_smtpPort is int port)
            builder.UseSetting("Smtp:Port", port.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (_smtpUseStartTls is bool startTls)
            builder.UseSetting("Smtp:UseStartTls", startTls ? "true" : "false");

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
            // Skipped when the test explicitly wants to exercise the production
            // conditional registration branch (PF3 registration tests).
            if (!_skipFakeEmailSender)
            {
                services.RemoveAll<IEmailSender>();
                services.AddSingleton<IEmailSender>(Email);
            }

            // Hermetic photo storage — no SeaweedFS required.
            services.RemoveAll<IPhotoStorage>();
            services.AddSingleton<IPhotoStorage>(Photos);

            // ── P2-6 bridge plumbing ──
            // Named HttpClient used by the chat proxy + extraction jobs.
            // Route it through an in-memory handler the per-test code can
            // script with responses + assert captured requests against.
            services.AddHttpClient(ExtractRecipeFromUrlJob.HttpClientName)
                .ConfigurePrimaryHttpMessageHandler(() => ExtractorHandler)
                .ConfigureHttpClient(client =>
                {
                    client.BaseAddress = new Uri("http://python-extractor.test/");
                    client.Timeout = TimeSpan.FromSeconds(10);
                });

            // Shared HMAC secret so the signer's PostConfigure check passes
            // on the test host's ExtractorOptions instance (env var is
            // absent in the test process).
            services.PostConfigure<FamilienKochbuch.Api.Services.ExtractorOptions>(opts =>
            {
                if (string.IsNullOrWhiteSpace(opts.SharedSecret))
                    opts.SharedSecret = "test-secret";
            });

            // Replace Hangfire's real IBackgroundJobClient with a
            // capturing double so enqueue-endpoint tests can assert the
            // job type + arguments without a running Hangfire server.
            services.RemoveAll<IBackgroundJobClient>();
            services.AddSingleton<IBackgroundJobClient>(Jobs);
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

    /// <summary>PF3 — fluent helper for the registration tests. Sets the
    /// <c>Smtp:Host</c> and <c>Smtp:FromAddress</c> configuration values
    /// that the conditional registration in Program.cs reads. Optional
    /// <paramref name="port"/> + <paramref name="useStartTls"/> flip the
    /// matching settings for integration tests that point the real
    /// SmtpEmailSender at a netDumbster fake.</summary>
    public FamilienKochbuchWebApplicationFactory WithSmtpConfig(
        string host, string fromAddress, int? port = null, bool? useStartTls = null)
    {
        _smtpHost = host;
        _smtpFromAddress = fromAddress;
        _smtpPort = port;
        _smtpUseStartTls = useStartTls;
        return this;
    }

    /// <summary>PF3 — skip the FakeEmailSender override so the
    /// production registration (NoOp vs Smtp) is resolved as-is.</summary>
    public FamilienKochbuchWebApplicationFactory WithoutFakeEmailSender()
    {
        _skipFakeEmailSender = true;
        return this;
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
