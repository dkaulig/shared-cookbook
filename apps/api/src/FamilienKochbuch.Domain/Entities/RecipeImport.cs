using FamilienKochbuch.Domain.Enums;

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

    /// <summary>Maximum length of the stored Azure deployment name.
    /// Azure's public names (e.g. <c>gpt-5.1-codex-mini</c>) sit well
    /// under 100; the 200-char cap protects against a malicious /
    /// malformed deployment string turning the text column into a
    /// storage exploit.</summary>
    public const int ModelDeploymentMaxLength = 200;

    /// <summary>Maximum length of the stored server-derived German
    /// progress label. All auto-derived labels fit comfortably under
    /// 200 chars; the cap exists as defence-in-depth in case a future
    /// format string misbehaves.</summary>
    public const int ProgressLabelMaxLength = 200;

    /// <summary>Initial overall progress for a row that has just entered
    /// the Queued phase. Matches the top of the Queued phase-range
    /// (0-5%) in the weighted formula — the user sees "5%" immediately
    /// rather than a jarring "0%".</summary>
    public const int QueuedStartProgress = 5;

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

        // PV1 — phase-aware progress fields. Start in Queued at 0% within-phase;
        // AttemptNumber = 1 on creation, LastProgressAt tracks heartbeat for the
        // stale-progress UI banner.
        Phase = RecipeImportPhase.Queued;
        PhaseProgress = 0;
        AttemptNumber = 1;
        LastProgressAt = createdAt;
        ProgressLabel = null;
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

    // ── Token-usage tracking ────────────────────────────────────────
    //
    // Populated by <see cref="RecordUsage"/> when the Python response
    // arrives. All four fields stay <c>null</c> on any path that never
    // hit the LLM (e.g. a transport failure, or an import that errored
    // before the extractor got a chance to run). The admin KI-usage
    // dashboard treats null == "no data" and skips the row.
    public int? PromptTokens { get; private set; }
    public int? CompletionTokens { get; private set; }
    public int? CachedPromptTokens { get; private set; }
    public string? ModelDeployment { get; private set; }

    // ── PV1: Phase-aware progress (see video-import-progress-design.md) ──
    //
    // Phase / PhaseProgress are the authoritative within-phase coordinates
    // the Python extractor callbacks populate. `Progress` stays the global
    // 0-100 number the existing UI binds to; it is computed from the
    // phase-weighted formula any time UpdateProgress accepts a change, so
    // the invariant `Progress = global(Phase, PhaseProgress)` always holds.
    //
    // ProgressLabel is a server-derived German string replacing the old
    // client-side `progressLabel.ts` helper — keeping derivation on the
    // server keeps the three surfaces (polled GET, SignalR event, stored
    // row) consistent without re-implementing the mapping twice.

    public RecipeImportPhase Phase { get; private set; } = RecipeImportPhase.Queued;
    public int PhaseProgress { get; private set; }
    public string? ProgressLabel { get; private set; }
    public long? BytesDownloaded { get; private set; }
    public long? BytesTotal { get; private set; }
    public int? SegmentsDone { get; private set; }
    public int? SegmentsTotal { get; private set; }
    public int AttemptNumber { get; private set; } = 1;
    public DateTimeOffset LastProgressAt { get; private set; }

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

        // Keep phase-aware fields aligned: the import is in terminal Done.
        Phase = RecipeImportPhase.Done;
        PhaseProgress = 100;
        ProgressLabel = ProgressLabelBuilder.Build(
            RecipeImportPhase.Done, bytesDownloaded: null, bytesTotal: null,
            segmentsDone: null, segmentsTotal: null);
        LastProgressAt = completedAt;
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

        // Phase tracking: pin to Error terminal; the actual detail message
        // lives in ErrorMessage. Progress stays at whatever value the last
        // accepted update computed — the UI freezes the bar at that point.
        Phase = RecipeImportPhase.Error;
        ProgressLabel = ProgressLabelBuilder.Build(
            RecipeImportPhase.Error, bytesDownloaded: null, bytesTotal: null,
            segmentsDone: null, segmentsTotal: null);
        LastProgressAt = completedAt;
    }

    /// <summary>
    /// Records the token-usage numbers the Python extractor reported
    /// for this import. Only legal while the import is running —
    /// the job reads the <c>X-Extractor-*</c> headers off the Python
    /// response and calls this before transitioning to <see cref="ImportStatus.Done"/>
    /// or <see cref="ImportStatus.Error"/>. Non-negative token counts
    /// and a non-blank model name are required; blank / negative
    /// values crash fast rather than silently being stored, because a
    /// silent bad record breaks the admin dashboard.
    /// </summary>
    public void RecordUsage(
        int promptTokens,
        int completionTokens,
        int cachedPromptTokens,
        string modelDeployment)
    {
        if (Status != ImportStatus.Running)
            throw new InvalidOperationException(
                $"RecordUsage is only legal while Running; current state is {Status}.");
        if (promptTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(promptTokens), promptTokens, "Prompt tokens must be >= 0.");
        if (completionTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(completionTokens), completionTokens, "Completion tokens must be >= 0.");
        if (cachedPromptTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(cachedPromptTokens), cachedPromptTokens, "Cached prompt tokens must be >= 0.");
        if (cachedPromptTokens > promptTokens)
            throw new ArgumentOutOfRangeException(
                nameof(cachedPromptTokens),
                cachedPromptTokens,
                "Cached prompt tokens cannot exceed total prompt tokens.");
        if (string.IsNullOrWhiteSpace(modelDeployment))
            throw new ArgumentException(
                "Model deployment name must not be blank.", nameof(modelDeployment));

        PromptTokens = promptTokens;
        CompletionTokens = completionTokens;
        CachedPromptTokens = cachedPromptTokens;
        ModelDeployment = Truncate(modelDeployment.Trim(), ModelDeploymentMaxLength);
    }

    // ── PV1: Phase-aware progress state machine ─────────────────────

    /// <summary>
    /// Applies an incoming phase-progress update from the Python extractor
    /// callback (<c>POST /api/internal/imports/{id}/progress</c>).
    /// Returns <c>false</c> — silently, no exception — when the update is
    /// discarded by one of the following guards:
    /// <list type="bullet">
    /// <item>The incoming <paramref name="phase"/> is a terminal state
    /// (<see cref="RecipeImportPhase.Done"/> / <see cref="RecipeImportPhase.Error"/>).
    /// Terminal transitions are owned by <see cref="MarkDone"/> /
    /// <see cref="MarkError"/>; accepting them via the progress callback
    /// would let a compromised Python reporter flip the import to Done
    /// without a persisted recipe. The endpoint layer returns 422 for
    /// this case; the domain guard is defence-in-depth for any future
    /// internal caller that wired its way around the endpoint
    /// validator.</item>
    /// <item>The incoming <paramref name="attempt"/> does not exactly
    /// match the current <see cref="AttemptNumber"/> (late callback from
    /// a superseded retry, OR a forged-future callback trying to claim
    /// attempt=999). Attempt counter is bumped only by
    /// <see cref="StartAttempt"/>, not by the callback; mis-numbered
    /// attempts silently drop so the endpoint stays 204-idempotent.</item>
    /// <item>The incoming (<paramref name="phase"/>, <paramref name="phaseProgress"/>)
    /// is not monotonically >= (current <see cref="Phase"/>, current
    /// <see cref="PhaseProgress"/>) — out-of-order network reordering.</item>
    /// <item>The current <see cref="Phase"/> is already terminal
    /// (<see cref="RecipeImportPhase.Done"/> or
    /// <see cref="RecipeImportPhase.Error"/>).</item>
    /// </list>
    ///
    /// Silent rejection (rather than throw) keeps the endpoint idempotent:
    /// the Python reporter is fire-and-forget, so out-of-order arrivals
    /// are normal under load and shouldn't surface as 5xx.
    ///
    /// On accept: stores all provided fields, recomputes the global
    /// <see cref="Progress"/> via the phase-weighted formula, auto-derives
    /// the German <see cref="ProgressLabel"/>, and stamps
    /// <see cref="LastProgressAt"/> with <paramref name="now"/>.
    /// </summary>
    public bool UpdateProgress(
        RecipeImportPhase phase,
        int phaseProgress,
        long? bytesDownloaded,
        long? bytesTotal,
        int? segmentsDone,
        int? segmentsTotal,
        int attempt,
        DateTimeOffset now)
    {
        if (phaseProgress is < 0 or > 100)
            throw new ArgumentOutOfRangeException(
                nameof(phaseProgress),
                phaseProgress,
                "Phase progress must be between 0 and 100.");
        if (attempt < 1)
            throw new ArgumentOutOfRangeException(
                nameof(attempt), attempt, "Attempt must be >= 1.");

        // Guard 0 (PV1 security): incoming terminal phase is never
        // allowed via the progress callback path. See XML-doc above —
        // only MarkDone / MarkError can transition to terminal, because
        // only they also persist the ResultJson / ErrorMessage the UI
        // needs to render the final state correctly.
        if (phase is RecipeImportPhase.Done or RecipeImportPhase.Error)
            return false;

        // Guard 1: terminal state is terminal. Both Done and Error ignore
        // any further callbacks so a late "transcribing 50%" can't un-do
        // a completed import.
        if (Phase is RecipeImportPhase.Done or RecipeImportPhase.Error)
            return false;

        // Guard 2 (PV1 security): stale or forged attempt. The attempt
        // counter is bumped exclusively by StartAttempt (the job
        // runner's retry-detection path); a progress callback claiming
        // a different attempt number is either a late callback from a
        // superseded retry (attempt < AttemptNumber) or a forged-future
        // replay (attempt > AttemptNumber). Both paths silently drop so
        // the monotonic phase guard cannot be wedged ahead of
        // legitimate updates.
        if (attempt != AttemptNumber)
            return false;

        // Guard 3: out-of-order within-attempt. Phases monotonically
        // increase (by the int value of the enum); within a phase the
        // progress number does too.
        if ((int)phase < (int)Phase)
            return false;
        if ((int)phase == (int)Phase && phaseProgress < PhaseProgress)
            return false;

        Phase = phase;
        PhaseProgress = phaseProgress;
        BytesDownloaded = bytesDownloaded;
        BytesTotal = bytesTotal;
        SegmentsDone = segmentsDone;
        SegmentsTotal = segmentsTotal;
        Progress = PhaseWeightedFormula.Compute(phase, phaseProgress);
        ProgressLabel = ProgressLabelBuilder.Build(
            phase, bytesDownloaded, bytesTotal, segmentsDone, segmentsTotal);
        LastProgressAt = now;

        // If a progress callback arrived while the row was still in
        // Queued ImportStatus (no MarkRunning was called), lift it into
        // Running so the existing status endpoint matches the phase
        // truth. Queued→Running is legal for every non-terminal phase.
        if (Status == ImportStatus.Queued && phase != RecipeImportPhase.Queued)
        {
            Status = ImportStatus.Running;
        }

        return true;
    }

    /// <summary>
    /// Marks the beginning of a fresh Hangfire attempt. Used when the
    /// <c>[AutomaticRetry]</c> supervisor re-runs a failed extraction:
    /// the attempt counter is bumped, phase resets to <c>Queued</c>,
    /// within-phase progress resets to 0, and the global <see cref="Progress"/>
    /// jumps back to <see cref="QueuedStartProgress"/> so the user sees
    /// the new attempt visibly restart rather than appear stuck on the
    /// previous value. Only legal while the import is not terminal.
    /// </summary>
    public void StartAttempt(int attemptNumber, DateTimeOffset now)
    {
        if (attemptNumber < 1)
            throw new ArgumentOutOfRangeException(
                nameof(attemptNumber), attemptNumber, "Attempt must be >= 1.");
        if (attemptNumber < AttemptNumber)
            throw new ArgumentOutOfRangeException(
                nameof(attemptNumber), attemptNumber,
                $"Attempt must not regress below current AttemptNumber {AttemptNumber}.");
        if (Status is ImportStatus.Done or ImportStatus.Error
            || Phase is RecipeImportPhase.Done or RecipeImportPhase.Error)
            throw new InvalidOperationException(
                $"Cannot start a new attempt on a terminal import (Status={Status}, Phase={Phase}).");

        AttemptNumber = attemptNumber;
        Phase = RecipeImportPhase.Queued;
        PhaseProgress = 0;
        Progress = QueuedStartProgress;
        BytesDownloaded = null;
        BytesTotal = null;
        SegmentsDone = null;
        SegmentsTotal = null;
        ProgressLabel = ProgressLabelBuilder.Build(
            RecipeImportPhase.Queued, bytesDownloaded: null, bytesTotal: null,
            segmentsDone: null, segmentsTotal: null);
        LastProgressAt = now;
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

/// <summary>
/// Phase-weighted formula mapping a (<see cref="RecipeImportPhase"/>,
/// within-phase percentage) pair to a global 0-100 <c>Progress</c>.
///
/// Ranges (match design §Phase-Weighted Formula):
/// <code>
/// Queued          → 0-5%    (5%)   — URL + Photo paths
/// Downloading     → 5-15%   (10%)  — URL path only
/// Transcribing    → 15-85%  (70%)  — URL path only (longest phase)
/// Structuring     → 85-95%  (10%)  — URL path only
/// PostProcessing  → 95-100% (5%)   — both paths
/// VisionAnalysis  → 5-95%   (90%)  — Photo path; swallows the URL-only
///                                    Downloading/Transcribing/Structuring
///                                    slots because photos is single-shot.
/// Done / Error    → 100%           — terminal
/// </code>
///
/// Global = phase_start + (phase_progress / 100) * phase_range, rounded
/// to the nearest integer. Kept <c>public</c> so the job runner can
/// reuse <see cref="StartOf"/> without duplicating the phase-boundary
/// table (single source of truth — any future phase-range tweak lives
/// in one place). Domain write-path call sites still go through
/// <see cref="RecipeImport.UpdateProgress"/> which enforces the guards.
/// </summary>
public static class PhaseWeightedFormula
{
    public static int Compute(RecipeImportPhase phase, int phaseProgress)
    {
        if (phaseProgress < 0) phaseProgress = 0;
        if (phaseProgress > 100) phaseProgress = 100;

        var (start, range) = RangeOf(phase);

        // Round half-up. With range ≤ 100 and phaseProgress ≤ 100 the
        // intermediate stays well within int range, so no long cast.
        var global = start + (range * phaseProgress + 50) / 100;
        if (global > 100) global = 100;
        if (global < 0) global = 0;
        return global;
    }

    /// <summary>
    /// Returns the global-progress value at the start of
    /// <paramref name="phase"/>. Used by <c>PythonExtractorRunner</c>
    /// to drive <see cref="RecipeImport.MarkRunning"/> in lockstep with
    /// the weighted formula — keeping both call sites on the same
    /// lookup table means a phase-boundary tweak can't silently drift
    /// between the domain formula and the job runner.
    /// </summary>
    public static int StartOf(RecipeImportPhase phase) => RangeOf(phase).start;

    private static (int start, int range) RangeOf(RecipeImportPhase phase) => phase switch
    {
        RecipeImportPhase.Queued => (0, 5),
        RecipeImportPhase.Downloading => (5, 10),
        RecipeImportPhase.Transcribing => (15, 70),
        RecipeImportPhase.Structuring => (85, 10),
        RecipeImportPhase.PostProcessing => (95, 5),
        RecipeImportPhase.VisionAnalysis => (5, 90),
        RecipeImportPhase.Done => (100, 0),
        RecipeImportPhase.Error => (100, 0),
        _ => throw new ArgumentOutOfRangeException(
            nameof(phase), phase, "Unknown RecipeImportPhase."),
    };
}

/// <summary>
/// Server-side German copy builder for the progress label. Centralising
/// the mapping here means the label is identical on the persisted row,
/// the polled status endpoint, and the SignalR event — no risk of the
/// frontend and backend drifting on wording. Labels stay short (≤ 200
/// chars, enforced by <see cref="RecipeImport.ProgressLabelMaxLength"/>)
/// so they fit the mobile progress card without wrapping awkwardly.
/// </summary>
internal static class ProgressLabelBuilder
{
    public static string Build(
        RecipeImportPhase phase,
        long? bytesDownloaded,
        long? bytesTotal,
        int? segmentsDone,
        int? segmentsTotal)
    {
        var raw = phase switch
        {
            RecipeImportPhase.Queued => "Warteschlange...",
            RecipeImportPhase.Downloading => BuildDownloading(bytesDownloaded, bytesTotal),
            RecipeImportPhase.Transcribing => BuildTranscribing(segmentsDone, segmentsTotal),
            RecipeImportPhase.Structuring => "Rezept wird strukturiert (Azure OpenAI)",
            RecipeImportPhase.PostProcessing => "Nachverarbeitung...",
            RecipeImportPhase.VisionAnalysis => "Fotos werden analysiert (Azure Vision)",
            RecipeImportPhase.Done => "Fertig",
            RecipeImportPhase.Error => "Fehler",
            _ => throw new ArgumentOutOfRangeException(
                nameof(phase), phase, "Unknown RecipeImportPhase."),
        };

        return raw.Length <= RecipeImport.ProgressLabelMaxLength
            ? raw
            : raw[..RecipeImport.ProgressLabelMaxLength];
    }

    private static string BuildDownloading(long? bytesDownloaded, long? bytesTotal)
    {
        if (bytesDownloaded is long done && bytesTotal is long total && total > 0)
        {
            var percent = (int)((done * 100L) / total);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            var totalMb = total / 1024.0 / 1024.0;
            var mbStr = totalMb.ToString("0.#", System.Globalization.CultureInfo.GetCultureInfo("de-DE"));
            return $"Video wird heruntergeladen ({percent}% von {mbStr} MB)";
        }
        return "Video wird heruntergeladen";
    }

    private static string BuildTranscribing(int? segmentsDone, int? segmentsTotal)
    {
        if (segmentsDone is int done && segmentsTotal is int total && total > 0)
        {
            if (done < 0) done = 0;
            if (done > total) done = total;
            return $"Audio wird transkribiert (Segment {done}/{total})";
        }
        return "Audio wird transkribiert";
    }
}
