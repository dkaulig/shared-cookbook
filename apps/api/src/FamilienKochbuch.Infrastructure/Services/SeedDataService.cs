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
    IConfiguration config,
    ILogger<SeedDataService> logger)
{
    internal const string DefaultAdminEmail = "admin@familien-kochbuch.local";
    internal const string DefaultAdminPassword = "ChangeMe!Admin2026";

    public async Task SeedAsync(CancellationToken ct = default)
    {
        var anyUser = await db.Users.AnyAsync(ct);
        if (anyUser)
            return;

        var email = config["ADMIN_EMAIL"];
        var password = config["ADMIN_PASSWORD"];

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
        admin.SetDisplayName("Admin");
        admin.EmailConfirmed = true;

        var result = await users.CreateAsync(admin, password!);
        if (!result.Succeeded)
        {
            var errors = string.Join(", ", result.Errors.Select(e => e.Description));
            throw new InvalidOperationException($"Failed to seed admin user: {errors}");
        }

        logger.LogInformation("Seeded initial Admin user {Email}", email);
    }
}
