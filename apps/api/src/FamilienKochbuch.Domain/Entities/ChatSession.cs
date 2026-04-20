namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// CR1 — persistent chat conversation owned by exactly one user. Holds
/// no messages directly; <see cref="ChatMessage"/> rows reference this
/// aggregate by <see cref="Id"/>.
///
/// Cross-user access is rejected at the endpoint layer (CR2) — a DB
/// FK to <c>AspNetUsers</c> is intentionally omitted because the
/// session-owning-user check already lives in-code and the cross-
/// context FK weight isn't worth it. The session → messages FK
/// (enforced on <see cref="ChatMessage"/>) stays in-context and is
/// valuable; it also drives cascade-delete when a session goes away.
///
/// The aggregate is append-only from a domain viewpoint: the assistant
/// doesn't edit user messages, users don't edit history. Title is the
/// only mutable piece (auto-titled after the first turn by the
/// fire-and-forget titler service landing in CR2), plus the
/// denormalised <see cref="MessageCount"/> + <see cref="UpdatedAt"/>
/// that power the sessions-list UI without a JOIN.
/// </summary>
public sealed class ChatSession
{
    /// <summary>Hard cap for titles — matches the auto-titler's "max
    /// 6 Wörter" prompt with headroom for manual renames.</summary>
    public const int TitleMaxLength = 120;

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }

    /// <summary>Session display name. <c>null</c> until the auto-titler
    /// (or a manual rename) sets it — the sessions-list UI falls back
    /// to a German placeholder when this is null.</summary>
    public string? Title { get; private set; }

    /// <summary>Denormalised message counter bumped via
    /// <see cref="RecordMessageAdded"/>. Kept here so the sessions-list
    /// can show "N Nachrichten" without an aggregate query.</summary>
    public int MessageCount { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Bumps on every title change + every message added; the
    /// sessions-list indexes <c>(UserId, UpdatedAt DESC)</c> to surface
    /// newest-active conversations first.</summary>
    public DateTimeOffset UpdatedAt { get; private set; }

    // EF-friendly parameterless ctor — domain construction goes through
    // the validating factory below.
    private ChatSession() { }

    /// <summary>
    /// Creates a fresh session owned by <paramref name="userId"/>. No
    /// title, no messages — both are populated by the first turn.
    /// </summary>
    public static ChatSession Create(Guid userId, DateTimeOffset now)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("userId required", nameof(userId));

        return new ChatSession
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Title = null,
            MessageCount = 0,
            CreatedAt = now,
            UpdatedAt = now,
        };
    }

    /// <summary>
    /// Sets or replaces the session title. Rejects blanks + anything
    /// over <see cref="TitleMaxLength"/>; trims whitespace so the
    /// stored form matches what the sessions-list renders.
    /// </summary>
    public void Rename(string title, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(title))
            throw new ArgumentException("title required", nameof(title));
        if (title.Length > TitleMaxLength)
            throw new ArgumentException($"title exceeds {TitleMaxLength}", nameof(title));

        Title = title.Trim();
        UpdatedAt = now;
    }

    /// <summary>
    /// Called by the turn handler after persisting each message (user
    /// + assistant). Bumps <see cref="MessageCount"/> and
    /// <see cref="UpdatedAt"/> together so the sessions-list order
    /// reflects activity without a JOIN onto <see cref="ChatMessage"/>.
    /// </summary>
    public void RecordMessageAdded(DateTimeOffset now)
    {
        MessageCount++;
        UpdatedAt = now;
    }
}
