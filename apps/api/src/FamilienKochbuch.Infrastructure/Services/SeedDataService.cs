using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Seeds the initial Admin user from environment variables on first boot.
/// Runs after migrations and is a no-op once any user exists.
/// </summary>
public class SeedDataService(
    AppDbContext db,
    UserManager<User> users,
    IPrivateCollectionService privateCollections,
    IConfiguration config,
    ILogger<SeedDataService> logger)
{
    internal const string DefaultAdminEmail = "admin@familien-kochbuch.local";
    internal const string DefaultAdminPassword = "ChangeMe!Admin2026";
    // BF1 #2 — the previous default ("Admin") was the role label, which
    // surfaced in revision history as if the role were the author's name.
    // Default to a person-shaped placeholder; deployers should override
    // via ADMIN_DISPLAY_NAME so collaborators see a real name.
    internal const string DefaultAdminDisplayName = "Familienkoch";

    // OPS1 — dedicated bot identity used by post-deploy smoke-live.sh and
    // any future orchestrator automation.  Email is a fixed service
    // identity, not operator-configurable; password flows in via the
    // ORCHESTRATOR_PASSWORD env var and is never logged.
    internal const string OrchestratorEmail = "orchestrator@kochbuch.kaulig.dev";
    internal const string OrchestratorDisplayName = "Orchestrator";

    public async Task SeedAsync(CancellationToken ct = default)
    {
        var anyUser = await db.Users.AnyAsync(ct);
        if (!anyUser)
        {
            await SeedAdminAsync(ct);
        }
        else
        {
            // Back-fill Private Sammlung for any pre-existing user (idempotent).
            // Needed when a DB created before S2 is reused — the auto-create
            // hook on signup/seed only fires for new users.
            await BackfillPrivateCollectionsAsync(ct);
        }

        // Orchestrator bot is seeded independently of the admin bootstrap:
        // it's expected on every environment that has ORCHESTRATOR_PASSWORD
        // configured, including ones that already have real users.
        await SeedOrchestratorBotAsync(ct);
    }

    private async Task SeedAdminAsync(CancellationToken ct)
    {
        var email = config["ADMIN_EMAIL"];
        var password = config["ADMIN_PASSWORD"];
        var displayName = config["ADMIN_DISPLAY_NAME"];

        var usingDefault = false;
        if (string.IsNullOrWhiteSpace(email))
        {
            email = DefaultAdminEmail;
            usingDefault = true;
        }
        if (string.IsNullOrWhiteSpace(password))
        {
            password = DefaultAdminPassword;
            usingDefault = true;
        }
        if (string.IsNullOrWhiteSpace(displayName))
        {
            displayName = DefaultAdminDisplayName;
        }

        if (usingDefault)
        {
            logger.LogWarning(
                "!! SEED WARNING !! No ADMIN_EMAIL / ADMIN_PASSWORD env vars set — " +
                "falling back to development defaults (email={Email}). " +
                "Override via environment variables before shipping to production.",
                email);
        }

        var admin = new User { Role = UserRole.Admin };
        admin.SetEmail(email!);
        admin.SetDisplayName(displayName!);
        admin.EmailConfirmed = true;

        var result = await users.CreateAsync(admin, password!);
        if (!result.Succeeded)
        {
            var errors = string.Join(", ", result.Errors.Select(e => e.Description));
            throw new InvalidOperationException($"Failed to seed admin user: {errors}");
        }

        await privateCollections.EnsurePrivateCollectionAsync(admin.Id, ct);

        logger.LogInformation("Seeded initial Admin user {Email}", email);
    }

    /// <summary>
    /// OPS1 — idempotently seed the orchestrator service-account.
    /// No-op when <c>ORCHESTRATOR_PASSWORD</c> is unset (local dev still
    /// works without it) or when a row with the fixed bot email already
    /// exists (password / role are never rewritten on re-boot, so a
    /// rotated env var won't silently invalidate live refresh tokens).
    /// </summary>
    private async Task SeedOrchestratorBotAsync(CancellationToken ct)
    {
        var password = config["ORCHESTRATOR_PASSWORD"];
        if (string.IsNullOrWhiteSpace(password))
            return;

        if (await users.FindByEmailAsync(OrchestratorEmail) is not null)
            return;

        // Role = User (not Admin) — the bot is a regular family member so
        // smoke tests exercise the same permission path real users walk.
        var bot = new User { Role = UserRole.User };
        bot.SetEmail(OrchestratorEmail);
        bot.SetDisplayName(OrchestratorDisplayName);
        bot.EmailConfirmed = true;

        var result = await users.CreateAsync(bot, password);
        if (!result.Succeeded)
        {
            // Errors from Identity (password policy, duplicate email) are
            // surfaced but without echoing the password — the Identity
            // framework itself never leaks it into e.Description.
            var errors = string.Join(", ", result.Errors.Select(e => e.Description));
            throw new InvalidOperationException($"Failed to seed orchestrator bot: {errors}");
        }

        await privateCollections.EnsurePrivateCollectionAsync(bot.Id, ct);

        // Do NOT log the password or the env var value — deliberately
        // only the email (the service identity) makes it into the log.
        logger.LogInformation("Seeded orchestrator bot user {Email}", OrchestratorEmail);
    }

    private async Task BackfillPrivateCollectionsAsync(CancellationToken ct)
    {
        var userIds = await db.Users.Select(u => u.Id).ToListAsync(ct);
        foreach (var uid in userIds)
            await privateCollections.EnsurePrivateCollectionAsync(uid, ct);
    }
}
