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

    public async Task SeedAsync(CancellationToken ct = default)
    {
        var anyUser = await db.Users.AnyAsync(ct);
        if (anyUser)
        {
            // Back-fill Private Sammlung for any pre-existing user (idempotent).
            // Needed when a DB created before S2 is reused — the auto-create
            // hook on signup/seed only fires for new users.
            await BackfillPrivateCollectionsAsync(ct);
            return;
        }

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

    private async Task BackfillPrivateCollectionsAsync(CancellationToken ct)
    {
        var userIds = await db.Users.Select(u => u.Id).ToListAsync(ct);
        foreach (var uid in userIds)
            await privateCollections.EnsurePrivateCollectionAsync(uid, ct);
    }
}
