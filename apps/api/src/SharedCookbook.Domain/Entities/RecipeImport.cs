using SharedCookbook.Domain.Enums;

namespace SharedCookbook.Domain.Entities;

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

    /// <summary>LANG-1 — fixed length of the BCP-47 language code we
    /// persist. The whitelist is currently <c>de | en</c>, both 2-char
    /// ISO 639-1 codes; LANG-4 will widen the supported list but keep
    /// the 2-char shape. Strings longer than this are rejected — the
    /// caller should run <see cref="Api.Services.LanguageNormalizer"/>
    /// first.</summary>
    public const int RequestedLanguageMaxLength = 2;

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
        DateTimeOffset createdAt,
        Guid? targetRecipeId = null,
        string? requestedLanguage = null)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));
        if (targetRecipeId is { } tr && tr == Guid.Empty)
            throw new ArgumentException("TargetRecipeId must not be Guid.Empty.", nameof(targetRecipeId));

        Id = Guid.NewGuid();
        UserId = userId;
        GroupId = groupId;
        Source = source;
        SourceUrl = NormalizeSourceUrl(sourceUrl);
        Status = ImportStatus.Queued;
        Progress = 0;
        CreatedAt = createdAt;
        TargetRecipeId = targetRecipeId;
        RequestedLanguage = NormalizeRequestedLanguage(requestedLanguage);

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

    /// <summary>
    /// COVER-0 — ordered list of <see cref="StagedPhoto"/> ids produced
    /// by the <see cref="Api.Services.CandidateAttacher"/> from the
    /// Python extractor's <c>candidate_thumbnails</c> list. Index 0 is
    /// the default Cover; the remaining entries are selectable
    /// alternatives in the import-cover-picker grid. Empty
    /// (not <c>null</c>) when the import produced no candidates or the
    /// downloads all failed — callers key off length, never
    /// null-ness. Populated once at the end of
    /// <c>ExtractRecipeFromUrlJob</c>; subsequent cover swaps on the
    /// recipe detail page don't mutate this list (the candidates stay
    /// available until the sweep reaps them).
    /// </summary>
    public Guid[] CandidateStagedPhotoIds { get; private set; } = Array.Empty<Guid>();

    /// <summary>
    /// REIMPORT-0 — id of the <see cref="Recipe"/> the URL-extract job
    /// should update in place on success, rather than letting the
    /// standard PF1 promote-flow create a brand-new recipe row. Non-null
    /// exclusively on imports enqueued by the reimport endpoint
    /// (<c>POST /api/recipes/{id}/reimport</c>); regular URL / Photo /
    /// Chat imports leave it null.
    ///
    /// Set once at creation time via the optional ctor parameter so the
    /// row's "this is a reimport" invariant can't be mutated after
    /// enqueue — callers that need a reimport build a fresh row pointing
    /// at the target recipe.
    /// </summary>
    public Guid? TargetRecipeId { get; private set; }

    /// <summary>
    /// LANG-1 — BCP-47 language code (<c>"de"</c> / <c>"en"</c>) the
    /// caller's UI was set to when this import was enqueued. Forwarded
    /// to the Python extractor as <c>Accept-Language</c> so the LLM
    /// emits structured-field values in the user's language. Nullable
    /// for two reasons:
    /// <list type="number">
    /// <item>Pre-LANG-1 rows (existing imports in production at rollout
    /// time) have no value; the runner falls back to
    /// <see cref="Api.Services.LanguageNormalizer.DefaultLanguage"/>.</item>
    /// <item>Direct-domain construction in tests / scripts that don't
    /// care about language doesn't have to thread the parameter.</item>
    /// </list>
    /// Persisted via the validating
    /// <see cref="NormalizeRequestedLanguage"/> helper so a malformed
    /// value (longer than <see cref="RequestedLanguageMaxLength"/>)
    /// fails fast at construction rather than at SQL-write time.
    /// </summary>
    public string? RequestedLanguage { get; private set; }

    /// <summary>
    /// AI-Normalize toggle (2026-04-27 design). Mirrors the python-extractor's
    /// <c>config_snapshot.ai_normalize_active</c> flag and records that the
    /// caller opted into LLM-based JSON-LD normalisation for a blog import.
    ///
    /// <para>Semantics per the python-extractor's audit contract: the flag
    /// captures USER INTENT for a blog import where the LLM-normalize path
    /// COULD apply. Stays <c>false</c> on:
    /// <list type="bullet">
    /// <item>Imports submitted with the toggle off (default).</item>
    /// <item>Video / photo / chat imports — the toggle has no effect there.</item>
    /// <item>Blog imports lacking JSON-LD — the python pipeline skips the
    /// LLM-normalize branch and reports <c>ai_normalize_active=false</c>
    /// even when <c>force_llm=true</c> was sent.</item>
    /// </list></para>
    ///
    /// <para>Defaults to <c>false</c>. The job stamps it via
    /// <see cref="RecordAiNormalizeActive"/> after reading the python
    /// extractor's response. The reimport-dialog reads it back so the
    /// toggle pre-fills with the last import's intent.</para>
    /// </summary>
    public bool AiNormalizeActive { get; private set; }

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

    /// <summary>
    /// AI-Normalize toggle (2026-04-27 design). Records the
    /// <c>config_snapshot.ai_normalize_active</c> flag the python extractor
    /// returned. Idempotent on a Hangfire retry that re-applies the same
    /// value. Distinct from <see cref="RecordUsage"/> in that it has no
    /// pre-condition on <see cref="ImportStatus"/>: the runner stamps the
    /// flag right after the HTTP success path returns and BEFORE the
    /// terminal <see cref="MarkDone"/> transition, but a reimport job's
    /// terminal-state writer may also call this once during the in-place
    /// recipe-update path.
    /// </summary>
    public void RecordAiNormalizeActive(bool active)
    {
        AiNormalizeActive = active;
    }

    /// <summary>
    /// COVER-0 — records the ordered list of candidate staged-photo ids
    /// the <see cref="Api.Services.CandidateAttacher"/> produced for this
    /// import. Idempotent on a no-op repeat with the same array.
    /// Re-attaching a different array throws — the candidate set is
    /// determined once at the end of the extraction job; a second call
    /// means a logic error (double-attach race). Empty
    /// <paramref name="candidateStagedPhotoIds"/> is accepted (no-op).
    /// </summary>
    public void AttachCandidateStagedPhotos(Guid[] candidateStagedPhotoIds)
    {
        if (candidateStagedPhotoIds is null)
            throw new ArgumentNullException(nameof(candidateStagedPhotoIds));
        if (candidateStagedPhotoIds.Any(id => id == Guid.Empty))
            throw new ArgumentException(
                "Candidate ids must not contain Guid.Empty.",
                nameof(candidateStagedPhotoIds));

        // Idempotent no-op when the caller re-attaches the same array
        // (Hangfire retry of a post-Done step).
        if (CandidateStagedPhotoIds.SequenceEqual(candidateStagedPhotoIds))
            return;

        if (CandidateStagedPhotoIds.Length > 0)
            throw new InvalidOperationException(
                $"Import {Id} already has {CandidateStagedPhotoIds.Length} candidate staged-photos; refusing to overwrite with a different set.");

        CandidateStagedPhotoIds = candidateStagedPhotoIds;
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
    /// Slice 3 — user-initiated retry of a previously-failed import.
    /// Resets the row back to the same shape it had immediately after
    /// <see cref="RecipeImport(Guid, Guid, ImportSource, string?, DateTimeOffset, Guid?, string?)"/>:
    /// <see cref="Status"/> back to <see cref="ImportStatus.Queued"/>,
    /// <see cref="Phase"/> to <see cref="RecipeImportPhase.Queued"/>,
    /// <see cref="AttemptNumber"/> to 1, all transit telemetry
    /// (<see cref="BytesDownloaded"/> / <see cref="BytesTotal"/> /
    /// <see cref="SegmentsDone"/> / <see cref="SegmentsTotal"/>) cleared,
    /// <see cref="ErrorMessage"/> + <see cref="ProgressLabel"/> +
    /// <see cref="CompletedAt"/> nulled. Identity (<see cref="Id"/>,
    /// <see cref="UserId"/>, <see cref="GroupId"/>, <see cref="Source"/>,
    /// <see cref="SourceUrl"/>, <see cref="CreatedAt"/>) survives so the
    /// row remains the same persistent unit the user is staring at.
    /// <see cref="LastProgressAt"/> is bumped to <paramref name="at"/> so
    /// the stale-progress UI banner re-arms cleanly.
    ///
    /// <para>Distinct from <see cref="StartAttempt"/>: that path is the
    /// Hangfire AutomaticRetry hook (which bumps <see cref="AttemptNumber"/>
    /// and is only legal on a non-terminal row); <c>RetryFromFailed</c> is
    /// the user-initiated reset from the <c>Failed</c> terminal state and
    /// drops back to attempt 1.</para>
    ///
    /// <para>Throws <see cref="InvalidOperationException"/> when called
    /// on a row whose <see cref="Status"/> isn't <see cref="ImportStatus.Error"/>.
    /// The endpoint layer translates the throw into a 409 / <c>import_not_failed</c>
    /// response; the throw itself is defence-in-depth so a future caller
    /// that bypasses the endpoint can't move a Pending / Running / Done
    /// row back to Queued.</para>
    /// </summary>
    public void RetryFromFailed(DateTimeOffset at)
    {
        if (Status != ImportStatus.Error)
            throw new InvalidOperationException(
                $"RetryFromFailed is only legal from Error; current status is {Status}.");

        Status = ImportStatus.Queued;
        Phase = RecipeImportPhase.Queued;
        Progress = 0;
        PhaseProgress = 0;
        AttemptNumber = 1;
        ErrorMessage = null;
        ProgressLabel = null;
        BytesDownloaded = null;
        BytesTotal = null;
        SegmentsDone = null;
        SegmentsTotal = null;
        CompletedAt = null;
        LastProgressAt = at;
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

    private static string? NormalizeRequestedLanguage(string? requestedLanguage)
    {
        if (string.IsNullOrWhiteSpace(requestedLanguage)) return null;
        var trimmed = requestedLanguage.Trim();
        if (trimmed.Length > RequestedLanguageMaxLength)
            throw new ArgumentException(
                $"Requested language must be at most {RequestedLanguageMaxLength} characters.",
                nameof(requestedLanguage));
        return trimmed.ToLowerInvariant();
    }

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
