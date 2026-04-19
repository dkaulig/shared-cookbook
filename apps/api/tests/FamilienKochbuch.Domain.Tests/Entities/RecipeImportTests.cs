using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// Invariants for the <see cref="RecipeImport"/> aggregate introduced in
/// P2-5. The entity backs the "Rezeptimport" async flow: a <see cref="RecipeImport"/>
/// row is created in state <see cref="ImportStatus.Queued"/> when the user
/// enqueues an import, transitions through <see cref="ImportStatus.Running"/>
/// as the Hangfire job drives progress, and settles into
/// <see cref="ImportStatus.Done"/> or <see cref="ImportStatus.Error"/>.
/// </summary>
public class RecipeImportTests
{
    private static RecipeImport NewImport(
        ImportSource source = ImportSource.Url,
        string? sourceUrl = "https://example.com/rezept",
        DateTimeOffset? createdAt = null) =>
        new(
            userId: Guid.NewGuid(),
            groupId: Guid.NewGuid(),
            source: source,
            sourceUrl: sourceUrl,
            createdAt: createdAt ?? DateTimeOffset.UtcNow);

    [Fact]
    public void Constructor_Sets_Queued_Defaults()
    {
        var now = DateTimeOffset.UtcNow;
        var userId = Guid.NewGuid();
        var groupId = Guid.NewGuid();

        var import = new RecipeImport(
            userId: userId,
            groupId: groupId,
            source: ImportSource.Url,
            sourceUrl: "https://example.com/rezept",
            createdAt: now);

        Assert.NotEqual(Guid.Empty, import.Id);
        Assert.Equal(userId, import.UserId);
        Assert.Equal(groupId, import.GroupId);
        Assert.Equal(ImportSource.Url, import.Source);
        Assert.Equal(ImportStatus.Queued, import.Status);
        Assert.Equal(0, import.Progress);
        Assert.Equal("https://example.com/rezept", import.SourceUrl);
        Assert.Null(import.ResultJson);
        Assert.Null(import.ErrorMessage);
        Assert.Equal(now, import.CreatedAt);
        Assert.Null(import.CompletedAt);
    }

    [Fact]
    public void Constructor_Rejects_Empty_UserId()
    {
        Assert.Throws<ArgumentException>(() => new RecipeImport(
            userId: Guid.Empty,
            groupId: Guid.NewGuid(),
            source: ImportSource.Url,
            sourceUrl: "https://example.com/r",
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Rejects_Empty_GroupId()
    {
        Assert.Throws<ArgumentException>(() => new RecipeImport(
            userId: Guid.NewGuid(),
            groupId: Guid.Empty,
            source: ImportSource.Url,
            sourceUrl: "https://example.com/r",
            createdAt: DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Constructor_Allows_Null_SourceUrl_For_Photos()
    {
        var import = NewImport(source: ImportSource.Photos, sourceUrl: null);
        Assert.Null(import.SourceUrl);
        Assert.Equal(ImportSource.Photos, import.Source);
    }

    [Fact]
    public void Constructor_Trims_SourceUrl()
    {
        var import = NewImport(sourceUrl: "   https://example.com/r   ");
        Assert.Equal("https://example.com/r", import.SourceUrl);
    }

    [Fact]
    public void MarkRunning_Transitions_From_Queued_And_Clamps_Progress()
    {
        var import = NewImport();

        import.MarkRunning(10);

        Assert.Equal(ImportStatus.Running, import.Status);
        Assert.Equal(10, import.Progress);
    }

    [Fact]
    public void MarkRunning_Updates_Progress_While_Running()
    {
        var import = NewImport();
        import.MarkRunning(10);

        import.MarkRunning(70);

        Assert.Equal(ImportStatus.Running, import.Status);
        Assert.Equal(70, import.Progress);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(101)]
    public void MarkRunning_Rejects_Out_Of_Range_Progress(int invalid)
    {
        var import = NewImport();
        Assert.Throws<ArgumentOutOfRangeException>(() => import.MarkRunning(invalid));
    }

    [Fact]
    public void MarkRunning_Allows_Progress_Not_To_Regress()
    {
        var import = NewImport();
        import.MarkRunning(70);

        // We accept lower values (e.g. a retry attempting to redo earlier
        // steps). Callers get the latest hint the job wants to publish.
        import.MarkRunning(40);

        Assert.Equal(40, import.Progress);
    }

    [Fact]
    public void MarkDone_Transitions_To_Done_And_Sets_Result()
    {
        var import = NewImport();
        import.MarkRunning(50);

        var result = "{\"title\":\"Spätzle\"}";
        var completedAt = DateTimeOffset.UtcNow;
        import.MarkDone(result, completedAt);

        Assert.Equal(ImportStatus.Done, import.Status);
        Assert.Equal(100, import.Progress);
        Assert.Equal(result, import.ResultJson);
        Assert.Null(import.ErrorMessage);
        Assert.Equal(completedAt, import.CompletedAt);
    }

    [Fact]
    public void MarkDone_Rejects_Empty_Result()
    {
        var import = NewImport();
        Assert.Throws<ArgumentException>(() => import.MarkDone("   ", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkError_Transitions_To_Error_With_Message()
    {
        var import = NewImport();
        import.MarkRunning(40);

        var completedAt = DateTimeOffset.UtcNow;
        import.MarkError("Video nicht erreichbar.", completedAt);

        Assert.Equal(ImportStatus.Error, import.Status);
        Assert.Equal("Video nicht erreichbar.", import.ErrorMessage);
        Assert.Null(import.ResultJson);
        Assert.Equal(completedAt, import.CompletedAt);
        // Progress retained at last reported value — the UI keeps showing
        // the bar frozen where the job failed.
        Assert.Equal(40, import.Progress);
    }

    [Fact]
    public void MarkError_Rejects_Blank_Message()
    {
        var import = NewImport();
        Assert.Throws<ArgumentException>(() => import.MarkError("   ", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkError_Caps_Message_Length()
    {
        var import = NewImport();
        var long_ = new string('x', RecipeImport.ErrorMessageMaxLength + 50);

        import.MarkError(long_, DateTimeOffset.UtcNow);

        Assert.Equal(RecipeImport.ErrorMessageMaxLength, import.ErrorMessage!.Length);
    }

    [Fact]
    public void MarkDone_After_MarkError_Is_Rejected()
    {
        var import = NewImport();
        import.MarkError("boom", DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() =>
            import.MarkDone("{\"title\":\"x\"}", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkError_After_MarkDone_Is_Rejected()
    {
        var import = NewImport();
        import.MarkDone("{\"title\":\"x\"}", DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() =>
            import.MarkError("boom", DateTimeOffset.UtcNow));
    }

    [Fact]
    public void MarkRunning_After_Terminal_State_Is_Rejected()
    {
        var import = NewImport();
        import.MarkDone("{\"title\":\"x\"}", DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() => import.MarkRunning(50));
    }

    // ── StageTransitPayload (P2-6) ──────────────────────────────────

    [Fact]
    public void StageTransitPayload_Seeds_ResultJson_While_Queued()
    {
        var import = NewImport(source: ImportSource.Photos, sourceUrl: null);

        import.StageTransitPayload("[\"https://cdn/x.jpg\"]");

        Assert.Equal("[\"https://cdn/x.jpg\"]", import.ResultJson);
        Assert.Equal(ImportStatus.Queued, import.Status);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void StageTransitPayload_Rejects_Blank(string payload)
    {
        var import = NewImport(source: ImportSource.Photos, sourceUrl: null);
        Assert.Throws<ArgumentException>(() => import.StageTransitPayload(payload));
    }

    [Fact]
    public void StageTransitPayload_Rejected_Once_Running()
    {
        var import = NewImport();
        import.MarkRunning(10);

        Assert.Throws<InvalidOperationException>(() =>
            import.StageTransitPayload("[\"x\"]"));
    }

    [Fact]
    public void StageTransitPayload_Rejected_Once_Done()
    {
        var import = NewImport();
        import.MarkDone("{\"title\":\"x\"}", DateTimeOffset.UtcNow);

        Assert.Throws<InvalidOperationException>(() =>
            import.StageTransitPayload("[\"x\"]"));
    }

    // ── RecordUsage (PF2) ────────────────────────────────────────────

    [Fact]
    public void RecordUsage_Stores_Token_Counts_While_Running()
    {
        var import = NewImport();
        import.MarkRunning(50);

        import.RecordUsage(
            promptTokens: 1000,
            completionTokens: 250,
            cachedPromptTokens: 800,
            modelDeployment: "gpt-5.1-chat");

        Assert.Equal(1000, import.PromptTokens);
        Assert.Equal(250, import.CompletionTokens);
        Assert.Equal(800, import.CachedPromptTokens);
        Assert.Equal("gpt-5.1-chat", import.ModelDeployment);
        // State unchanged — RecordUsage doesn't transition.
        Assert.Equal(ImportStatus.Running, import.Status);
    }

    [Fact]
    public void RecordUsage_Rejects_Before_Running()
    {
        var import = NewImport();
        Assert.Throws<InvalidOperationException>(() =>
            import.RecordUsage(10, 5, 0, "gpt-5.1"));
    }

    [Fact]
    public void RecordUsage_Rejects_After_Done()
    {
        var import = NewImport();
        import.MarkDone("{\"t\":\"x\"}", DateTimeOffset.UtcNow);
        Assert.Throws<InvalidOperationException>(() =>
            import.RecordUsage(10, 5, 0, "gpt-5.1"));
    }

    [Fact]
    public void RecordUsage_Rejects_After_Error()
    {
        var import = NewImport();
        import.MarkError("boom", DateTimeOffset.UtcNow);
        Assert.Throws<InvalidOperationException>(() =>
            import.RecordUsage(10, 5, 0, "gpt-5.1"));
    }

    [Theory]
    [InlineData(-1, 0, 0)]
    [InlineData(0, -1, 0)]
    [InlineData(0, 0, -1)]
    public void RecordUsage_Rejects_Negative_Counts(int prompt, int completion, int cached)
    {
        var import = NewImport();
        import.MarkRunning(10);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            import.RecordUsage(prompt, completion, cached, "gpt-5.1"));
    }

    [Fact]
    public void RecordUsage_Rejects_Cached_Exceeding_Prompt()
    {
        var import = NewImport();
        import.MarkRunning(10);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            import.RecordUsage(promptTokens: 100, completionTokens: 10,
                cachedPromptTokens: 200, modelDeployment: "gpt-5.1"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void RecordUsage_Rejects_Blank_Model(string model)
    {
        var import = NewImport();
        import.MarkRunning(10);
        Assert.Throws<ArgumentException>(() =>
            import.RecordUsage(10, 5, 0, model));
    }

    [Fact]
    public void RecordUsage_Caps_Model_Length()
    {
        var import = NewImport();
        import.MarkRunning(10);
        var long_ = new string('x', RecipeImport.ModelDeploymentMaxLength + 50);

        import.RecordUsage(10, 5, 0, long_);

        Assert.Equal(RecipeImport.ModelDeploymentMaxLength, import.ModelDeployment!.Length);
    }

    [Fact]
    public void RecordUsage_Allows_Zero_Counts()
    {
        // Zero is a legitimate value when the provider returns an
        // empty usage envelope (mock provider, error path mid-stream).
        // Only negatives are rejected.
        var import = NewImport();
        import.MarkRunning(10);
        import.RecordUsage(0, 0, 0, "mock");
        Assert.Equal(0, import.PromptTokens);
        Assert.Equal("mock", import.ModelDeployment);
    }
}
