namespace SharedCookbook.Domain.Entities;

/// <summary>
/// Kind of chat-side LLM call logged in <see cref="ChatUsageLog"/>.
///
/// <list type="bullet">
/// <item><see cref="ChatTurn"/> — a single <c>POST /api/chat</c>
/// conversational turn.</item>
/// <item><see cref="ChatToRecipe"/> — <c>POST /api/chat/{sid}/to-recipe</c>
/// structuring the dialogue into a recipe.</item>
/// </list>
///
/// The enum is stored as <c>int</c> in the database so renames don't
/// shift existing rows.
/// </summary>
public enum ChatUsageKind
{
    ChatTurn = 0,
    ChatToRecipe = 1,
}

/// <summary>
/// Per-call record of token usage for the synchronous chat proxy
/// endpoints. One row per successful Python call — missing rows
/// mean the call never completed (auth failure, 4xx from Python,
/// network blip) which is the same semantic as <see cref="RecipeImport"/>
/// columns staying <c>null</c>.
///
/// Unlike <see cref="RecipeImport"/>, chat doesn't need a state
/// machine — the request-response round-trip is synchronous and this
/// row is either written entirely or not at all, so every column is
/// non-nullable (except of course model deployment which is required
/// by construction).
/// </summary>
public sealed class ChatUsageLog
{
    /// <summary>Maximum length of the opaque session id. The Python
    /// side constrains its session_id to 200 chars; we follow suit so
    /// the round-trip is loss-less.</summary>
    public const int SessionIdMaxLength = 200;

    /// <summary>Matches <see cref="RecipeImport.ModelDeploymentMaxLength"/>.</summary>
    public const int ModelDeploymentMaxLength = 200;

    // Parameterless ctor for EF materialisation — callers must use the
    // validating ctor below.
    private ChatUsageLog() { }

    public ChatUsageLog(
        Guid userId,
        string sessionId,
        ChatUsageKind kind,
        int promptTokens,
        int completionTokens,
        int cachedPromptTokens,
        string modelDeployment,
        DateTimeOffset createdAt)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (string.IsNullOrWhiteSpace(sessionId))
            throw new ArgumentException("Session id must not be blank.", nameof(sessionId));
        if (sessionId.Length > SessionIdMaxLength)
            throw new ArgumentException(
                $"Session id must be at most {SessionIdMaxLength} characters.",
                nameof(sessionId));
        if (promptTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(promptTokens), promptTokens, "Prompt tokens must be >= 0.");
        if (completionTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(completionTokens), completionTokens, "Completion tokens must be >= 0.");
        if (cachedPromptTokens < 0)
            throw new ArgumentOutOfRangeException(
                nameof(cachedPromptTokens),
                cachedPromptTokens,
                "Cached prompt tokens must be >= 0.");
        if (cachedPromptTokens > promptTokens)
            throw new ArgumentOutOfRangeException(
                nameof(cachedPromptTokens),
                cachedPromptTokens,
                "Cached prompt tokens cannot exceed total prompt tokens.");
        if (string.IsNullOrWhiteSpace(modelDeployment))
            throw new ArgumentException(
                "Model deployment name must not be blank.", nameof(modelDeployment));

        Id = Guid.NewGuid();
        UserId = userId;
        SessionId = sessionId.Trim();
        Kind = kind;
        PromptTokens = promptTokens;
        CompletionTokens = completionTokens;
        CachedPromptTokens = cachedPromptTokens;
        ModelDeployment = modelDeployment.Trim().Length > ModelDeploymentMaxLength
            ? modelDeployment.Trim()[..ModelDeploymentMaxLength]
            : modelDeployment.Trim();
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }
    public string SessionId { get; private set; } = string.Empty;
    public ChatUsageKind Kind { get; private set; }
    public int PromptTokens { get; private set; }
    public int CompletionTokens { get; private set; }
    public int CachedPromptTokens { get; private set; }
    public string ModelDeployment { get; private set; } = string.Empty;
    public DateTimeOffset CreatedAt { get; private set; }
}
