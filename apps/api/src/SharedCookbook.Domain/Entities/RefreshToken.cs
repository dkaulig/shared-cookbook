namespace SharedCookbook.Domain.Entities;

/// <summary>
/// Server-side record of a refresh token issued to a user. The raw token
/// value is never persisted — only a SHA-256 hash — so a leaked DB dump
/// cannot be replayed against the auth endpoints. Rotation links tokens
/// via <see cref="ReplacedByTokenId"/>, which forms the "family" that
/// reuse-detection revokes when a rotated token is presented again.
/// </summary>
public class RefreshToken
{
    // EF-friendly parameterless ctor. Private so domain consumers go through
    // the validating constructor below.
    private RefreshToken() { }

    public RefreshToken(
        Guid userId,
        string tokenHash,
        DateTimeOffset issuedAt,
        DateTimeOffset expiresAt)
    {
        if (string.IsNullOrWhiteSpace(tokenHash))
            throw new ArgumentException("Token hash must not be empty.", nameof(tokenHash));

        if (expiresAt <= issuedAt)
            throw new ArgumentException(
                "Refresh token expiry must be strictly after issuance.", nameof(expiresAt));

        Id = Guid.NewGuid();
        UserId = userId;
        TokenHash = tokenHash;
        IssuedAt = issuedAt;
        ExpiresAt = expiresAt;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    /// <summary>SHA-256 hash of the raw refresh token. Raw value is sent to the
    /// client once in an HTTP-only cookie and never touches the database.</summary>
    public string TokenHash { get; private set; } = string.Empty;

    public DateTimeOffset IssuedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    /// <summary>When this token was rotated into its successor. Null unless rotated.</summary>
    public DateTimeOffset? RotatedAt { get; private set; }

    /// <summary>When this token was revoked (logout, reuse-detection, password reset).
    /// Null unless revoked.</summary>
    public DateTimeOffset? RevokedAt { get; private set; }

    /// <summary>Id of the token that rotated this one. Non-null implies <see cref="RotatedAt"/> set.</summary>
    public Guid? ReplacedByTokenId { get; private set; }

    /// <summary>True if usable at <paramref name="now"/> — not expired, not rotated, not revoked.</summary>
    public bool IsActive(DateTimeOffset now) =>
        RotatedAt is null && RevokedAt is null && now < ExpiresAt;

    /// <summary>Records rotation into the successor token. One-shot — a second call throws.</summary>
    public void MarkRotated(DateTimeOffset at, Guid replacementTokenId)
    {
        if (RotatedAt is not null)
            throw new InvalidOperationException("Refresh token has already been rotated.");

        RotatedAt = at;
        ReplacedByTokenId = replacementTokenId;
    }

    /// <summary>Marks the token as revoked. Idempotent — keeps the first timestamp so
    /// a subsequent family-wide sweep doesn't overwrite the actual revocation instant.</summary>
    public void Revoke(DateTimeOffset at)
    {
        if (RevokedAt is null)
            RevokedAt = at;
    }
}
