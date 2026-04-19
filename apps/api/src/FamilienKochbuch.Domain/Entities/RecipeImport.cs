namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// Origin of a <see cref="RecipeImport"/>. URL = video host or blog;
/// Photos = 1..N ordered images; Chat = a conversational session that
/// was condensed into a recipe.
/// </summary>
public enum ImportSource
{
    Url = 0,
    Photos = 1,
    Chat = 2,
}

/// <summary>
/// Lifecycle states for a <see cref="RecipeImport"/>. Terminal states
/// are <see cref="Done"/> and <see cref="Error"/>.
/// </summary>
public enum ImportStatus
{
    Queued = 0,
    Running = 1,
    Done = 2,
    Error = 3,
}

/// <summary>
/// Tracks an asynchronous recipe-extraction job end-to-end. Created in
/// <see cref="ImportStatus.Queued"/> state by the API endpoint that
/// enqueues the Hangfire job, driven through <see cref="ImportStatus.Running"/>
/// by the job itself (progress hints 10 → 40 → 70 → 95), and settled
/// into <see cref="ImportStatus.Done"/> (with <see cref="ResultJson"/>
/// populated) or <see cref="ImportStatus.Error"/> (with
/// <see cref="ErrorMessage"/> populated) when the pipeline returns.
///
/// The entity is intentionally dumb about HTTP/queue concerns — those
/// live in the Hangfire jobs — but owns the state machine + validation.
/// </summary>
public sealed class RecipeImport
{
    public const int ErrorMessageMaxLength = 2000;
    public const int SourceUrlMaxLength = 2000;

    // EF needs a parameterless ctor for materialization. Kept private so
    // domain construction always goes through the validating ctor below.
    private RecipeImport() { }

    public RecipeImport(
        Guid userId,
        Guid groupId,
        ImportSource source,
        string? sourceUrl,
        DateTimeOffset createdAt)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));

        Id = Guid.NewGuid();
        UserId = userId;
        GroupId = groupId;
        Source = source;
        SourceUrl = NormalizeSourceUrl(sourceUrl);
        Status = ImportStatus.Queued;
        Progress = 0;
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public Guid GroupId { get; private set; }
    public ImportSource Source { get; private set; }
    public ImportStatus Status { get; private set; }
    public int Progress { get; private set; }
    public string? SourceUrl { get; private set; }
    public string? ResultJson { get; private set; }
    public string? ErrorMessage { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset? CompletedAt { get; private set; }

    // ── State transitions ───────────────────────────────────────────

    /// <summary>
    /// Seeds <see cref="ResultJson"/> with transit data the background
    /// job needs before calling Python (e.g. the ordered photo URL
    /// list for the Photos source). Only legal while the import is
    /// still <see cref="ImportStatus.Queued"/> — once a job is
    /// running the field is owned by the job's progress + MarkDone
    /// contract.
    ///
    /// This is the P2-6 enqueue-side counterpart to
    /// <see cref="ExtractRecipeFromPhotosJob"/>'s transit contract.
    /// Keeping it as a named domain method rather than a direct
    /// setter lets the invariant be enforced at one place.
    /// </summary>
    public void StageTransitPayload(string payloadJson)
    {
        if (string.IsNullOrWhiteSpace(payloadJson))
            throw new ArgumentException("Transit payload must not be blank.", nameof(payloadJson));
        if (Status != ImportStatus.Queued)
            throw new InvalidOperationException(
                $"Transit payload can only be staged while Queued; current state is {Status}.");
        ResultJson = payloadJson;
    }

    /// <summary>
    /// Transitions the import to <see cref="ImportStatus.Running"/> (if
    /// still queued) and records the latest progress hint. Safe to call
    /// multiple times from the running job.
    /// </summary>
    public void MarkRunning(int progress)
    {
        if (progress is < 0 or > 100)
            throw new ArgumentOutOfRangeException(
                nameof(progress),
                progress,
                "Progress must be between 0 and 100.");
        if (Status is ImportStatus.Done or ImportStatus.Error)
            throw new InvalidOperationException(
                $"Cannot transition to Running from terminal state {Status}.");

        Status = ImportStatus.Running;
        Progress = progress;
    }

    /// <summary>
    /// Transitions the import to <see cref="ImportStatus.Done"/> and
    /// persists the structured result JSON produced by the Python
    /// extractor.
    /// </summary>
    public void MarkDone(string resultJson, DateTimeOffset completedAt)
    {
        if (string.IsNullOrWhiteSpace(resultJson))
            throw new ArgumentException("Result JSON must not be blank.", nameof(resultJson));
        if (Status is ImportStatus.Done or ImportStatus.Error)
            throw new InvalidOperationException(
                $"Cannot transition to Done from terminal state {Status}.");

        Status = ImportStatus.Done;
        Progress = 100;
        ResultJson = resultJson;
        ErrorMessage = null;
        CompletedAt = completedAt;
    }

    /// <summary>
    /// Transitions the import to <see cref="ImportStatus.Error"/> with a
    /// user-facing German error message. Progress stays pinned at the
    /// last reported value so the UI can freeze the bar.
    /// </summary>
    public void MarkError(string errorMessage, DateTimeOffset completedAt)
    {
        if (string.IsNullOrWhiteSpace(errorMessage))
            throw new ArgumentException("Error message must not be blank.", nameof(errorMessage));
        if (Status is ImportStatus.Done or ImportStatus.Error)
            throw new InvalidOperationException(
                $"Cannot transition to Error from terminal state {Status}.");

        Status = ImportStatus.Error;
        ResultJson = null;
        ErrorMessage = Truncate(errorMessage.Trim(), ErrorMessageMaxLength);
        CompletedAt = completedAt;
    }

    // Public setter used by the overload with only (message) — kept around
    // for EF proxy friendliness; call sites use the DateTimeOffset overload.
    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    private static string? NormalizeSourceUrl(string? sourceUrl)
    {
        if (string.IsNullOrWhiteSpace(sourceUrl)) return null;
        var trimmed = sourceUrl.Trim();
        if (trimmed.Length > SourceUrlMaxLength)
            throw new ArgumentException(
                $"Source URL must be at most {SourceUrlMaxLength} characters.",
                nameof(sourceUrl));
        return trimmed;
    }
}
