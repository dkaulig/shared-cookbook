using System.Text.RegularExpressions;
using FamilienKochbuch.Domain.Enums;
using Microsoft.AspNetCore.Identity;

namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// Application user. Extends <see cref="IdentityUser{TKey}"/> with a Guid PK
/// and Familien-Kochbuch-specific profile data (display name, soft-delete,
/// app-level role). Kept intentionally narrow — invites, refresh tokens,
/// ratings, etc. live in their own aggregates.
/// </summary>
public class User : IdentityUser<Guid>
{
    // RFC 5322-lite: local-part + "@" + domain-label(.label)+. Matches the
    // subset of addresses we actually want to allow (no quoted locals,
    // no IP literals). Anchored, case-insensitive.
    private static readonly Regex EmailRegex = new(
        @"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)+$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private const int DisplayNameMaxLength = 80;

    public User()
    {
        Id = Guid.NewGuid();
    }

    /// <summary>Human-readable name shown in the UI. 1..80 characters, trimmed, not blank.</summary>
    public string DisplayName { get; private set; } = string.Empty;

    /// <summary>Creation timestamp (UTC).</summary>
    public DateTimeOffset CreatedAt { get; private set; } = DateTimeOffset.UtcNow;

    /// <summary>Soft-delete marker. Null until the user is deleted.</summary>
    public DateTimeOffset? DeletedAt { get; private set; }

    /// <summary>Application-level role; orthogonal to group-level roles.</summary>
    public UserRole Role { get; set; } = UserRole.User;

    /// <summary>Sets <see cref="DisplayName"/> after trimming and length validation.</summary>
    public void SetDisplayName(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException("Display name must not be blank.", nameof(value));

        var trimmed = value.Trim();
        if (trimmed.Length > DisplayNameMaxLength)
            throw new ArgumentException(
                $"Display name must be at most {DisplayNameMaxLength} characters.",
                nameof(value));

        DisplayName = trimmed;
    }

    /// <summary>Normalizes the email to lowercase + trim and validates format.
    /// Also keeps <c>UserName</c> in sync (ASP.NET Identity uses UserName as the login).</summary>
    public void SetEmail(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException("Email must not be blank.", nameof(value));

        var normalized = value.Trim().ToLowerInvariant();
        if (!EmailRegex.IsMatch(normalized))
            throw new ArgumentException($"'{value}' is not a valid email address.", nameof(value));

        Email = normalized;
        UserName = normalized;
    }

    /// <summary>Marks the user as soft-deleted at the given instant.</summary>
    public void MarkDeleted(DateTimeOffset at)
    {
        DeletedAt = at;
    }
}
