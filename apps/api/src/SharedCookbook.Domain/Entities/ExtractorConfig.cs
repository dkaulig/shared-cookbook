namespace SharedCookbook.Domain.Entities;

/// <summary>
/// Value-encoding discriminator for <see cref="ExtractorConfig"/>. The
/// stored JSON payload's shape is derived from this — string /
/// string_list expect strings, int / float expect numbers, bool expects
/// a JSON <c>true</c>/<c>false</c> literal. Persisted as <c>int</c> so a
/// future rename in the enum can't silently shift existing rows.
/// </summary>
public enum ExtractorConfigValueType
{
    String = 0,
    Int = 1,
    Float = 2,
    Bool = 3,
    StringList = 4,
}

/// <summary>
/// CFG-0 — one DB-backed row per hot-configurable extractor knob
/// (prompt / temperature / feature-flag / threshold). Storage layout is
/// deliberately narrow:
///
/// <list type="bullet">
/// <item><see cref="Key"/> — dotted string PK (e.g.
/// <c>llm.structured.temperature</c>). Admin UI + Python config loader
/// both address rows by this single string.</item>
/// <item><see cref="ValueJson"/> — the value as a JSON-encoded string
/// (<c>"0.3"</c>, <c>"true"</c>, <c>"["bit.ly","t.co"]"</c>). Stored as
/// <c>jsonb</c> on Postgres, <c>TEXT</c> on SQLite. Callers parse against
/// <see cref="ValueType"/> on read; the domain never invents a rich
/// value-object hierarchy here — raw JSON round-trips cleanly to every
/// consumer (.NET, Python, React).</item>
/// <item><see cref="ValueType"/> — the type hint the
/// <c>ConfigKeyValidator</c> uses to parse + range-check an admin PUT
/// before it lands here. Immutable after seed; a key's type is part of
/// its contract.</item>
/// <item><see cref="Version"/> — monotonic, optimistic-concurrency
/// counter. The admin UI includes <c>expectedVersion</c> on PUT; the
/// endpoint returns 409 when it diverges from the server row.</item>
/// </list>
///
/// The entity deliberately exposes only a small set of state
/// transitions: <see cref="UpdateValue"/> for admin edits (bumps
/// <see cref="Version"/>, stamps <see cref="UpdatedBy"/> +
/// <see cref="UpdatedAt"/>) and the private ctor for EF materialisation.
/// Seed rows go through the ctor with <c>updatedBy: null</c> so an
/// operator can later spot "rows I haven't touched yet" in the admin
/// history view.
/// </summary>
public sealed class ExtractorConfig
{
    /// <summary>Maximum length of a config key. Dotted keys stay well
    /// under this; 100 is a generous safety cap that matches the design
    /// doc and guards the text column against a malicious key turning
    /// into a storage exploit.</summary>
    public const int KeyMaxLength = 100;

    // Parameterless ctor for EF materialisation. Kept private so every
    // domain-level construction goes through the validating ctor below.
    private ExtractorConfig() { }

    public ExtractorConfig(
        string key,
        string valueJson,
        ExtractorConfigValueType valueType,
        DateTimeOffset updatedAt,
        Guid? updatedBy = null)
    {
        if (string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("Key must not be blank.", nameof(key));
        var trimmed = key.Trim();
        if (trimmed.Length > KeyMaxLength)
            throw new ArgumentException(
                $"Key must be at most {KeyMaxLength} characters.", nameof(key));
        if (string.IsNullOrWhiteSpace(valueJson))
            throw new ArgumentException("ValueJson must not be blank.", nameof(valueJson));
        if (!Enum.IsDefined(typeof(ExtractorConfigValueType), valueType))
            throw new ArgumentOutOfRangeException(
                nameof(valueType), valueType, "Unknown ExtractorConfigValueType.");
        if (updatedBy is { } ub && ub == Guid.Empty)
            throw new ArgumentException(
                "UpdatedBy must not be Guid.Empty; pass null for system-seeded rows.",
                nameof(updatedBy));

        Key = trimmed;
        ValueJson = valueJson;
        ValueType = valueType;
        UpdatedAt = updatedAt;
        UpdatedBy = updatedBy;
        Version = 0;
    }

    public string Key { get; private set; } = string.Empty;
    public string ValueJson { get; private set; } = string.Empty;
    public ExtractorConfigValueType ValueType { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public Guid? UpdatedBy { get; private set; }

    /// <summary>
    /// Monotonic counter bumped on every <see cref="UpdateValue"/> call.
    /// Admin UI PUTs carry <c>expectedVersion</c>; the endpoint rejects
    /// with 409 on a divergence so concurrent edits from two admin tabs
    /// don't silently overwrite each other. Also used by the Python
    /// extractor to stamp <c>config_snapshot.prompt_version</c> onto
    /// every extraction result for reproducibility.
    /// </summary>
    public int Version { get; private set; }

    /// <summary>
    /// Applies an admin edit to the row. <see cref="Version"/> increments
    /// by exactly 1 (never regresses — the caller is expected to use
    /// optimistic-concurrency before reaching here). The previous value
    /// is returned so the caller can persist an
    /// <see cref="ExtractorConfigHistory"/> row atomically in the same
    /// transaction.
    /// </summary>
    /// <returns>The <see cref="ValueJson"/> as it was before this call —
    /// the "old value" side of the audit entry.</returns>
    public string UpdateValue(
        string newValueJson,
        DateTimeOffset updatedAt,
        Guid? updatedBy)
    {
        if (string.IsNullOrWhiteSpace(newValueJson))
            throw new ArgumentException("ValueJson must not be blank.", nameof(newValueJson));
        if (updatedBy is { } ub && ub == Guid.Empty)
            throw new ArgumentException(
                "UpdatedBy must not be Guid.Empty; pass null for system edits.",
                nameof(updatedBy));

        var previous = ValueJson;
        ValueJson = newValueJson;
        UpdatedAt = updatedAt;
        UpdatedBy = updatedBy;
        Version += 1;
        return previous;
    }
}

/// <summary>
/// CFG-0 — immutable audit row written atomically alongside every
/// <see cref="ExtractorConfig.UpdateValue"/>. Each row records the exact
/// old + new JSON payloads so the admin UI can render a per-key "last
/// 10 edits" timeline and (if needed) paste an old value back into the
/// PUT body to roll forward.
///
/// No state-transition methods — the row is write-once. EF materialisation
/// goes through the parameterless ctor; domain code always uses the
/// validating ctor below.
/// </summary>
public sealed class ExtractorConfigHistory
{
    // Parameterless ctor for EF. Private so domain construction is
    // routed through the validating ctor.
    private ExtractorConfigHistory() { }

    public ExtractorConfigHistory(
        string key,
        string oldValueJson,
        string newValueJson,
        DateTimeOffset changedAt,
        Guid? changedBy)
    {
        if (string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("Key must not be blank.", nameof(key));
        var trimmed = key.Trim();
        if (trimmed.Length > ExtractorConfig.KeyMaxLength)
            throw new ArgumentException(
                $"Key must be at most {ExtractorConfig.KeyMaxLength} characters.", nameof(key));
        if (oldValueJson is null)
            throw new ArgumentException("OldValueJson must not be null.", nameof(oldValueJson));
        if (string.IsNullOrWhiteSpace(newValueJson))
            throw new ArgumentException("NewValueJson must not be blank.", nameof(newValueJson));
        if (changedBy is { } cb && cb == Guid.Empty)
            throw new ArgumentException(
                "ChangedBy must not be Guid.Empty; pass null for system edits.",
                nameof(changedBy));

        Id = Guid.NewGuid();
        Key = trimmed;
        OldValueJson = oldValueJson;
        NewValueJson = newValueJson;
        ChangedAt = changedAt;
        ChangedBy = changedBy;
    }

    public Guid Id { get; private set; }
    public string Key { get; private set; } = string.Empty;
    public string OldValueJson { get; private set; } = string.Empty;
    public string NewValueJson { get; private set; } = string.Empty;
    public DateTimeOffset ChangedAt { get; private set; }
    public Guid? ChangedBy { get; private set; }
}
