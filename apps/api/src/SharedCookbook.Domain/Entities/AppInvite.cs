namespace SharedCookbook.Domain.Entities;

/// <summary>
/// App-level invite. A user generates one, shares the signup URL manually
/// or by email, and the recipient consumes it during signup. Single-use,
/// time-bounded (default 14 days, enforced at creation by the service layer).
/// Domain invariants: 64-char token, expiry strictly after creation, used
/// exactly once.
/// </summary>
public class AppInvite
{
    /// <summary>Expected token length. 64 chars = 48 random bytes in base64 or
    /// 32 hex-bytes — either way more than enough entropy to rule out guessing.</summary>
    public const int TokenLength = 64;

    // EF-friendly parameterless constructor — keep private so domain consumers
    // must go through the validating ctor below.
    private AppInvite() { }

    public AppInvite(
        string token,
        Guid createdByUserId,
        string? email,
        DateTimeOffset createdAt,
        DateTimeOffset expiresAt)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length != TokenLength)
            throw new ArgumentException(
                $"Invite token must be exactly {TokenLength} characters.", nameof(token));

        if (expiresAt <= createdAt)
            throw new ArgumentException(
                "Invite expiration must be strictly after creation.", nameof(expiresAt));

        Id = Guid.NewGuid();
        Token = token;
        CreatedByUserId = createdByUserId;
        Email = string.IsNullOrWhiteSpace(email) ? null : email.Trim().ToLowerInvariant();
        CreatedAt = createdAt;
        ExpiresAt = expiresAt;
    }

    public Guid Id { get; private set; }

    /// <summary>Opaque token shared in the signup URL. Unique across the table.</summary>
    public string Token { get; private set; } = string.Empty;

    /// <summary>User who generated the invite.</summary>
    public Guid CreatedByUserId { get; private set; }

    /// <summary>Optional hint — we pre-fill the signup form when present. Not enforced
    /// during consumption (invite works for any email).</summary>
    public string? Email { get; private set; }

    /// <summary>User who redeemed the invite. Null until consumed.</summary>
    public Guid? UsedByUserId { get; private set; }

    /// <summary>Instant the invite was consumed. Null until consumed.</summary>
    public DateTimeOffset? UsedAt { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    /// <summary>True if the invite can still be used at <paramref name="now"/>.</summary>
    public bool IsValid(DateTimeOffset now) =>
        UsedByUserId is null && now < ExpiresAt;

    /// <summary>Marks the invite as consumed. Throws if already used — the service
    /// layer must check <see cref="IsValid"/> first and wrap signup in a transaction.</summary>
    public void MarkUsed(Guid userId, DateTimeOffset usedAt)
    {
        if (UsedByUserId is not null)
            throw new InvalidOperationException("Invite has already been used.");

        UsedByUserId = userId;
        UsedAt = usedAt;
    }
}
