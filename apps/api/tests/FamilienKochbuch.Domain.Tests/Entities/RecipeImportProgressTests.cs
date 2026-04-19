using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// PV1 — invariants for the phase-aware progress state machine added to
/// <see cref="RecipeImport"/>: <see cref="RecipeImport.UpdateProgress"/>,
/// <see cref="RecipeImport.StartAttempt"/>, the phase-weighted global
/// progress formula, and the German-label auto-derivation.
///
/// Kept as a separate test class from <c>RecipeImportTests</c> so the
/// pre-PV1 invariants stay visually untouched and the ~20 PV1 cases
/// are easy to count.
/// </summary>
public class RecipeImportProgressTests
{
    private static RecipeImport NewImport() => new(
        userId: Guid.NewGuid(),
        groupId: Guid.NewGuid(),
        source: ImportSource.Url,
        sourceUrl: "https://example.com/r",
        createdAt: new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero));

    private static DateTimeOffset At(int minute) =>
        new(2026, 4, 19, 12, minute, 0, TimeSpan.Zero);

    // ── Constructor defaults for new progress fields ──────────────────

    [Fact]
    public void Constructor_Seeds_Phase_Progress_Defaults()
    {
        var createdAt = new DateTimeOffset(2026, 4, 19, 12, 0, 0, TimeSpan.Zero);
        var import = new RecipeImport(
            userId: Guid.NewGuid(),
            groupId: Guid.NewGuid(),
            source: ImportSource.Url,
            sourceUrl: "https://x",
            createdAt: createdAt);

        Assert.Equal(RecipeImportPhase.Queued, import.Phase);
        Assert.Equal(0, import.PhaseProgress);
        Assert.Null(import.ProgressLabel);
        Assert.Null(import.BytesDownloaded);
        Assert.Null(import.BytesTotal);
        Assert.Null(import.SegmentsDone);
        Assert.Null(import.SegmentsTotal);
        Assert.Equal(1, import.AttemptNumber);
        Assert.Equal(createdAt, import.LastProgressAt);
    }

    // ── Weighted formula ──────────────────────────────────────────────

    [Theory]
    [InlineData(RecipeImportPhase.Queued, 0, 0)]
    [InlineData(RecipeImportPhase.Queued, 100, 5)]
    [InlineData(RecipeImportPhase.Downloading, 0, 5)]
    [InlineData(RecipeImportPhase.Downloading, 50, 10)]
    [InlineData(RecipeImportPhase.Downloading, 100, 15)]
    [InlineData(RecipeImportPhase.Transcribing, 0, 15)]
    [InlineData(RecipeImportPhase.Transcribing, 50, 50)]
    [InlineData(RecipeImportPhase.Transcribing, 100, 85)]
    [InlineData(RecipeImportPhase.Structuring, 0, 85)]
    [InlineData(RecipeImportPhase.Structuring, 100, 95)]
    [InlineData(RecipeImportPhase.PostProcessing, 0, 95)]
    [InlineData(RecipeImportPhase.PostProcessing, 100, 100)]
    [InlineData(RecipeImportPhase.VisionAnalysis, 0, 5)]
    [InlineData(RecipeImportPhase.VisionAnalysis, 50, 50)]
    [InlineData(RecipeImportPhase.VisionAnalysis, 100, 95)]
    public void UpdateProgress_Weighted_Formula_Maps_Correctly(
        RecipeImportPhase phase, int phaseProgress, int expectedGlobal)
    {
        var import = NewImport();
        var ok = import.UpdateProgress(
            phase, phaseProgress,
            bytesDownloaded: null, bytesTotal: null,
            segmentsDone: null, segmentsTotal: null,
            attempt: 1, now: At(1));
        Assert.True(ok);
        Assert.Equal(expectedGlobal, import.Progress);
        Assert.Equal(phase, import.Phase);
        Assert.Equal(phaseProgress, import.PhaseProgress);
    }

    // ── Ordering + stale-attempt + terminal guards ────────────────────

    [Fact]
    public void UpdateProgress_Rejects_Backwards_Phase_Silently()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 50,
            null, null, null, null, attempt: 1, now: At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Downloading, 10,
            null, null, null, null, attempt: 1, now: At(2));

        Assert.False(ok);
        Assert.Equal(RecipeImportPhase.Transcribing, import.Phase);
        Assert.Equal(50, import.PhaseProgress);
        Assert.Equal(At(1), import.LastProgressAt); // unchanged
    }

    [Fact]
    public void UpdateProgress_Rejects_Same_Phase_Lower_Progress_Silently()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 60,
            null, null, null, null, attempt: 1, now: At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Transcribing, 40,
            null, null, null, null, attempt: 1, now: At(2));

        Assert.False(ok);
        Assert.Equal(60, import.PhaseProgress);
    }

    [Fact]
    public void UpdateProgress_Allows_Same_Phase_Equal_Progress()
    {
        // Equal is permitted — it's a heartbeat / re-publish. Label +
        // bytes/segments may have changed, so we accept and re-compute.
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 60,
            null, null, 3, 10, attempt: 1, now: At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Transcribing, 60,
            null, null, 4, 10, attempt: 1, now: At(2));

        Assert.True(ok);
        Assert.Equal(4, import.SegmentsDone);
        Assert.Equal(At(2), import.LastProgressAt);
    }

    [Fact]
    public void UpdateProgress_Rejects_Stale_Attempt_Silently()
    {
        var import = NewImport();
        import.StartAttempt(2, At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Transcribing, 50,
            null, null, null, null, attempt: 1, now: At(2));

        Assert.False(ok);
        // Phase should still reflect the StartAttempt reset.
        Assert.Equal(RecipeImportPhase.Queued, import.Phase);
    }

    [Fact]
    public void UpdateProgress_Accepts_Equal_Or_Newer_Attempt()
    {
        var import = NewImport();
        import.StartAttempt(2, At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Downloading, 20,
            null, null, null, null, attempt: 2, now: At(2));

        Assert.True(ok);
        Assert.Equal(RecipeImportPhase.Downloading, import.Phase);
        Assert.Equal(2, import.AttemptNumber);
    }

    [Fact]
    public void UpdateProgress_Rejects_After_Done_Silently()
    {
        var import = NewImport();
        import.MarkRunning(50);
        import.MarkDone("{\"t\":\"x\"}", At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.PostProcessing, 10,
            null, null, null, null, attempt: 1, now: At(2));

        Assert.False(ok);
        Assert.Equal(RecipeImportPhase.Done, import.Phase);
    }

    [Fact]
    public void UpdateProgress_Rejects_After_Error_Silently()
    {
        var import = NewImport();
        import.MarkRunning(30);
        import.MarkError("boom", At(1));

        var ok = import.UpdateProgress(
            RecipeImportPhase.Transcribing, 50,
            null, null, null, null, attempt: 1, now: At(2));

        Assert.False(ok);
        Assert.Equal(RecipeImportPhase.Error, import.Phase);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(101)]
    public void UpdateProgress_Throws_On_Out_Of_Range_PhaseProgress(int pp)
    {
        var import = NewImport();
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            import.UpdateProgress(
                RecipeImportPhase.Downloading, pp,
                null, null, null, null, attempt: 1, now: At(1)));
    }

    [Fact]
    public void UpdateProgress_Throws_On_Zero_Attempt()
    {
        var import = NewImport();
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            import.UpdateProgress(
                RecipeImportPhase.Downloading, 10,
                null, null, null, null, attempt: 0, now: At(1)));
    }

    // ── Side-effects: byte/segment fields + LastProgressAt + Status lift ──

    [Fact]
    public void UpdateProgress_Stores_Byte_And_Segment_Metadata()
    {
        var import = NewImport();
        var ok = import.UpdateProgress(
            RecipeImportPhase.Downloading, 30,
            bytesDownloaded: 3_800_000, bytesTotal: 12_700_000,
            segmentsDone: null, segmentsTotal: null,
            attempt: 1, now: At(1));

        Assert.True(ok);
        Assert.Equal(3_800_000, import.BytesDownloaded);
        Assert.Equal(12_700_000, import.BytesTotal);
    }

    [Fact]
    public void UpdateProgress_Lifts_Queued_Status_To_Running()
    {
        var import = NewImport();
        Assert.Equal(ImportStatus.Queued, import.Status);

        import.UpdateProgress(
            RecipeImportPhase.Downloading, 10,
            null, null, null, null, attempt: 1, now: At(1));

        Assert.Equal(ImportStatus.Running, import.Status);
    }

    [Fact]
    public void UpdateProgress_Updates_LastProgressAt_On_Accept()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Downloading, 10,
            null, null, null, null, attempt: 1, now: At(5));
        Assert.Equal(At(5), import.LastProgressAt);
    }

    // ── German progress-label auto-derivation ──────────────────────────

    [Fact]
    public void Label_Queued()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Queued, 0,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Warteschlange...", import.ProgressLabel);
    }

    [Fact]
    public void Label_Downloading_Without_Bytes()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Downloading, 0,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Video wird heruntergeladen", import.ProgressLabel);
    }

    [Fact]
    public void Label_Downloading_With_Bytes_Has_German_Decimal()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Downloading, 30,
            bytesDownloaded: 3_800_000, bytesTotal: 12_700_000,
            null, null, attempt: 1, now: At(1));

        Assert.NotNull(import.ProgressLabel);
        Assert.Contains("Video wird heruntergeladen", import.ProgressLabel);
        // German locale uses comma for decimal separator.
        Assert.Contains(",", import.ProgressLabel);
        Assert.Contains("MB", import.ProgressLabel);
    }

    [Fact]
    public void Label_Transcribing_Without_Segments()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 10,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Audio wird transkribiert", import.ProgressLabel);
    }

    [Fact]
    public void Label_Transcribing_With_Segments()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 65,
            null, null, segmentsDone: 13, segmentsTotal: 20,
            attempt: 1, now: At(1));
        Assert.Equal("Audio wird transkribiert (Segment 13/20)", import.ProgressLabel);
    }

    [Fact]
    public void Label_Structuring_Is_Azure_OpenAI()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Structuring, 50,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Rezept wird strukturiert (Azure OpenAI)", import.ProgressLabel);
    }

    [Fact]
    public void Label_PostProcessing()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.PostProcessing, 40,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Nachverarbeitung...", import.ProgressLabel);
    }

    [Fact]
    public void Label_VisionAnalysis()
    {
        var import = new RecipeImport(
            userId: Guid.NewGuid(), groupId: Guid.NewGuid(),
            source: ImportSource.Photos, sourceUrl: null, createdAt: At(0));
        import.UpdateProgress(
            RecipeImportPhase.VisionAnalysis, 50,
            null, null, null, null, attempt: 1, now: At(1));
        Assert.Equal("Fotos werden analysiert (Azure Vision)", import.ProgressLabel);
    }

    [Fact]
    public void Label_Done_Set_By_MarkDone()
    {
        var import = NewImport();
        import.MarkRunning(50);
        import.MarkDone("{\"t\":\"x\"}", At(1));
        Assert.Equal(RecipeImportPhase.Done, import.Phase);
        Assert.Equal("Fertig", import.ProgressLabel);
        Assert.Equal(100, import.Progress);
    }

    [Fact]
    public void Label_Error_Set_By_MarkError()
    {
        var import = NewImport();
        import.MarkRunning(40);
        import.MarkError("boom", At(1));
        Assert.Equal(RecipeImportPhase.Error, import.Phase);
        Assert.Equal("Fehler", import.ProgressLabel);
        // ErrorMessage carries the actual detail, not the label.
        Assert.Equal("boom", import.ErrorMessage);
    }

    // ── StartAttempt ──────────────────────────────────────────────────

    [Fact]
    public void StartAttempt_Resets_Phase_And_Bumps_Counter()
    {
        var import = NewImport();
        import.UpdateProgress(
            RecipeImportPhase.Transcribing, 70,
            bytesDownloaded: 1000, bytesTotal: 2000,
            segmentsDone: 5, segmentsTotal: 10,
            attempt: 1, now: At(1));

        import.StartAttempt(2, At(5));

        Assert.Equal(2, import.AttemptNumber);
        Assert.Equal(RecipeImportPhase.Queued, import.Phase);
        Assert.Equal(0, import.PhaseProgress);
        Assert.Equal(RecipeImport.QueuedStartProgress, import.Progress);
        Assert.Null(import.BytesDownloaded);
        Assert.Null(import.SegmentsDone);
        Assert.Equal("Warteschlange...", import.ProgressLabel);
        Assert.Equal(At(5), import.LastProgressAt);
    }

    [Fact]
    public void StartAttempt_Rejects_Regression()
    {
        var import = NewImport();
        import.StartAttempt(2, At(1));
        Assert.Throws<ArgumentOutOfRangeException>(() => import.StartAttempt(1, At(2)));
    }

    [Fact]
    public void StartAttempt_Rejects_After_Done()
    {
        var import = NewImport();
        import.MarkRunning(50);
        import.MarkDone("{\"t\":\"x\"}", At(1));
        Assert.Throws<InvalidOperationException>(() => import.StartAttempt(2, At(2)));
    }

    [Fact]
    public void StartAttempt_Rejects_After_Error()
    {
        var import = NewImport();
        import.MarkRunning(50);
        import.MarkError("boom", At(1));
        Assert.Throws<InvalidOperationException>(() => import.StartAttempt(2, At(2)));
    }
}
