using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Infrastructure.Persistence;
using SharedCookbook.Infrastructure.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

/// <summary>
/// Exercises <see cref="SeedDataService"/> with the SQLite in-memory
/// pattern used across the Infrastructure test suite.  Focused on the
/// OPS1 orchestrator-bot seed path — the admin-seed path is already
/// covered by the API-level integration tests (WebApplicationFactory).
/// </summary>
public class SeedDataServiceTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private ServiceProvider _provider = null!;
    private IPrivateCollectionService _privateCollections = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();

        // Minimal DI container so AddIdentityCore<User>() can resolve
        // UserManager<User> backed by AppDbContext — the same wiring
        // Program.cs uses, trimmed to what SeedDataService actually
        // touches.
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDbContext<AppDbContext>(opts => opts.UseSqlite(_connection));
        services.AddIdentityCore<User>(opts =>
            {
                opts.User.RequireUniqueEmail = true;
                opts.Password.RequireDigit = false;
                opts.Password.RequireLowercase = false;
                opts.Password.RequireUppercase = false;
                opts.Password.RequireNonAlphanumeric = false;
                opts.Password.RequiredLength = 8;
            })
            .AddRoles<IdentityRole<Guid>>()
            .AddEntityFrameworkStores<AppDbContext>();

        _privateCollections = Substitute.For<IPrivateCollectionService>();
        services.AddSingleton(_privateCollections);

        _provider = services.BuildServiceProvider();

        _db = _provider.GetRequiredService<AppDbContext>();
        await _db.Database.EnsureCreatedAsync();
    }

    public async Task DisposeAsync()
    {
        await _provider.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private SeedDataService BuildSeeder(IConfiguration config)
    {
        var users = _provider.GetRequiredService<UserManager<User>>();
        return new SeedDataService(
            _db,
            users,
            _privateCollections,
            config,
            NullLogger<SeedDataService>.Instance);
    }

    private static IConfiguration Config(Dictionary<string, string?> values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    // ── Orchestrator bot seed ──────────────────────────────────────────

    [Fact]
    public async Task Orchestrator_Bot_Not_Seeded_When_Password_Env_Var_Is_Absent()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
        });

        await BuildSeeder(config).SeedAsync();

        var bot = await _db.Users.FirstOrDefaultAsync(
            u => u.Email == "orchestrator@example.com");
        Assert.Null(bot);
    }

    [Fact]
    public async Task Orchestrator_Bot_Not_Seeded_When_Password_Env_Var_Is_Whitespace()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "   ",
        });

        await BuildSeeder(config).SeedAsync();

        var bot = await _db.Users.FirstOrDefaultAsync(
            u => u.Email == "orchestrator@example.com");
        Assert.Null(bot);
    }

    [Fact]
    public async Task Orchestrator_Bot_Seeded_On_First_Call_With_User_Role_And_Confirmed_Email()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPassword123!",
        });

        await BuildSeeder(config).SeedAsync();

        var bot = await _db.Users.SingleAsync(
            u => u.Email == "orchestrator@example.com");
        Assert.Equal("Orchestrator", bot.DisplayName);
        Assert.Equal(UserRole.User, bot.Role);
        Assert.True(bot.EmailConfirmed);

        // Password must be verifiable through the hasher — confirms the
        // env var actually flowed into CreateAsync.
        var users = _provider.GetRequiredService<UserManager<User>>();
        Assert.True(await users.CheckPasswordAsync(bot, "BotPassword123!"));

        // Bot is a regular User — it receives the same Private Sammlung
        // that any real family member would get on signup.  Two calls:
        // one for the admin bootstrap, one for the bot.
        await _privateCollections.Received(2).EnsurePrivateCollectionAsync(
            Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Orchestrator_Bot_Seeded_Next_To_Admin_On_First_Boot()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPassword123!",
        });

        await BuildSeeder(config).SeedAsync();

        Assert.Equal(2, await _db.Users.CountAsync());
        Assert.Equal(1, await _db.Users.CountAsync(u => u.Role == UserRole.Admin));
        Assert.Equal(1, await _db.Users.CountAsync(u => u.Role == UserRole.User));
    }

    [Fact]
    public async Task Orchestrator_Bot_Seed_Is_Idempotent_Password_Not_Rehashed_Role_Not_Changed()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPassword123!",
        });

        await BuildSeeder(config).SeedAsync();

        var firstHash = (await _db.Users.SingleAsync(
            u => u.Email == "orchestrator@example.com")).PasswordHash;

        // Detach so the second seed reloads from the DB instead of reusing
        // the tracked instance.
        _db.ChangeTracker.Clear();

        // Even if the operator rotates the env var, the second boot must
        // leave the existing bot row untouched — rehashing on every boot
        // would silently invalidate every live refresh token the bot holds.
        var rotated = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "SomeOtherPassword!",
        });
        await BuildSeeder(rotated).SeedAsync();

        var bot = await _db.Users.SingleAsync(
            u => u.Email == "orchestrator@example.com");
        // Hash-equality is the authoritative "not rehashed" guarantee.  We
        // deliberately don't assert "old password verifies / new doesn't"
        // here — an Identity hasher version bump would re-verify through
        // the rehash-on-verify path and make those assertions flaky
        // without the underlying seed-idempotency invariant actually
        // breaking.
        Assert.Equal(firstHash, bot.PasswordHash);
        Assert.Equal(UserRole.User, bot.Role);
    }

    [Fact]
    public async Task Orchestrator_Bot_Password_Rotates_When_Flag_Set()
    {
        // Seed once with password A.
        var firstConfig = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPasswordA1!",
        });
        await BuildSeeder(firstConfig).SeedAsync();

        var firstHash = (await _db.Users.SingleAsync(
            u => u.Email == "orchestrator@example.com")).PasswordHash;

        _db.ChangeTracker.Clear();

        // Change password env to B and set ORCHESTRATOR_PASSWORD_ROTATE=true.
        var rotateConfig = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPasswordB2!",
            ["ORCHESTRATOR_PASSWORD_ROTATE"] = "true",
        });
        await BuildSeeder(rotateConfig).SeedAsync();

        var bot = await _db.Users.SingleAsync(
            u => u.Email == "orchestrator@example.com");

        // Hash must have changed — the rotate path re-hashed via Identity.
        Assert.NotEqual(firstHash, bot.PasswordHash);

        // Password B works; password A no longer verifies.
        var users = _provider.GetRequiredService<UserManager<User>>();
        Assert.True(await users.CheckPasswordAsync(bot, "BotPasswordB2!"));
        Assert.False(await users.CheckPasswordAsync(bot, "BotPasswordA1!"));
    }

    [Fact]
    public async Task Orchestrator_Bot_Seed_Is_Idempotent_No_Duplicate_Row()
    {
        var config = Config(new()
        {
            ["ADMIN_EMAIL"] = "admin@test.local",
            ["ADMIN_PASSWORD"] = "AdminPassword123!",
            ["ORCHESTRATOR_PASSWORD"] = "BotPassword123!",
        });

        await BuildSeeder(config).SeedAsync();
        _db.ChangeTracker.Clear();
        await BuildSeeder(config).SeedAsync();

        Assert.Equal(1, await _db.Users.CountAsync(
            u => u.Email == "orchestrator@example.com"));
    }
}
