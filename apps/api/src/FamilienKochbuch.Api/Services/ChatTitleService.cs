using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Ai;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// CR2 — fire-and-forget auto-title generator. Triggered by the
/// <c>/turn</c> endpoint exactly once per session, after the first
/// user + assistant pair has been persisted.
///
/// Race-guard strategy — <c>Title-null-check-pattern</c> (not a
/// Semaphore): the service reloads the session inside its own scope and
/// exits early when <see cref="ChatSession.Title"/> is already set. A
/// second <c>/turn</c> that fires while the first title call is still
/// in flight loses the race harmlessly — whichever handler wins gets to
/// set the title, the loser no-ops. No lock contention across sessions,
/// no semaphore-dictionary leak if a session is abandoned mid-call.
///
/// Lives as a concrete class (not an interface) because the single
/// consumer is the turn endpoint and the test seam is an
/// <see cref="IAzureOpenAIChatClient"/> fake injected one level deeper.
/// </summary>
public sealed class ChatTitleService
{
    /// <summary>The base auto-title prompt. Public so the LANG-1b unit
    /// tests can assert "Build wraps the base, doesn't replace it"
    /// without re-encoding the whole string. The base prompt asks for
    /// a short title (≤ 6 words) and bans quotes / trailing punctuation
    /// so <see cref="NormaliseTitle"/> doesn't have to rip them off.</summary>
    public const string BaseTitleSystemPrompt =
        "Generate a short title (max 6 words) for this conversation. "
        + "Output the title as plain text — no surrounding quotes, no "
        + "trailing punctuation, no prefix.";

    private readonly AppDbContext _db;
    private readonly IAzureOpenAIChatClient _llm;
    private readonly TimeProvider _clock;
    private readonly ILogger<ChatTitleService> _logger;

    public ChatTitleService(
        AppDbContext db,
        IAzureOpenAIChatClient llm,
        TimeProvider clock,
        ILogger<ChatTitleService> logger)
    {
        _db = db;
        _llm = llm;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>
    /// LANG-1b — build the auto-title system prompt for the caller's
    /// UI language. Uses a SHORTER directive than
    /// <see cref="LanguageNormalizer.AppendDirective"/> because a
    /// title is a single short string — no need to enumerate
    /// "structured field values (title, description, …)". The
    /// "regardless of what language the chat content is in" clause is
    /// preserved because the chat history is real user content and
    /// therefore a prompt-injection surface (a German user chatting
    /// about an English recipe should still get a German title).
    ///
    /// Pinned wording so the LANG-1b tests don't drift.
    /// </summary>
    public static string BuildTitlePrompt(string lang)
    {
        var target = LanguageNormalizer.TargetName(lang);
        return BaseTitleSystemPrompt
            + $"\n\nAlways produce the title in {target} regardless of "
            + "what language the chat content is in.";
    }

    /// <summary>
    /// Generate and persist the title for <paramref name="sessionId"/>.
    /// No-op when the session is already titled, missing, or when the
    /// first user+assistant pair isn't present yet (shouldn't happen
    /// from the endpoint but keeps the method robust if called early).
    /// Swallows all exceptions — caller is fire-and-forget and logs via
    /// its own try/catch wrapper.
    ///
    /// LANG-1b — <paramref name="lang"/> is the UI language captured
    /// from the originating <c>Accept-Language</c> header at endpoint
    /// time. Forwarded to <see cref="BuildTitlePrompt"/> so a German
    /// user gets a German title and an English user gets an English
    /// title regardless of what language the chat content is in.
    /// </summary>
    public async Task GenerateAsync(Guid sessionId, string lang, CancellationToken ct)
    {
        var session = await _db.ChatSessions
            .FirstOrDefaultAsync(s => s.Id == sessionId, ct)
            .ConfigureAwait(false);
        if (session is null) return;
        if (!string.IsNullOrWhiteSpace(session.Title)) return;

        // SQLite can't ORDER BY DateTimeOffset — materialise then sort.
        // Postgres handles the composite IX_ChatMessages_Session_CreatedAt
        // index natively so this is a minor cost on the test path only.
        var loaded = await _db.ChatMessages
            .Where(m => m.SessionId == sessionId)
            .Select(m => new { m.Role, m.Content, m.CreatedAt })
            .ToListAsync(ct)
            .ConfigureAwait(false);
        var messages = loaded
            .OrderBy(m => m.CreatedAt)
            .Take(4)
            .Select(m => new { m.Role, m.Content })
            .ToList();
        if (messages.Count == 0) return;

        var llmMessages = new List<ChatCompletionMessage>(messages.Count + 1)
        {
            new("system", BuildTitlePrompt(lang)),
        };
        foreach (var m in messages)
        {
            var role = m.Role switch
            {
                ChatRole.User => "user",
                ChatRole.Assistant => "assistant",
                _ => "system",
            };
            llmMessages.Add(new ChatCompletionMessage(role, m.Content));
        }

        string raw;
        try
        {
            raw = await _llm.CompleteAsync(llmMessages, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Title completion failed for session {SessionId}", sessionId);
            return;
        }

        var title = NormaliseTitle(raw);
        if (string.IsNullOrWhiteSpace(title)) return;

        // Reload + re-check inside the same scope so we don't overwrite
        // a concurrently-set title (double-call race) and so we apply
        // the domain's length + whitespace validation via Rename.
        var latest = await _db.ChatSessions
            .FirstOrDefaultAsync(s => s.Id == sessionId, ct)
            .ConfigureAwait(false);
        if (latest is null) return;
        if (!string.IsNullOrWhiteSpace(latest.Title)) return;

        try
        {
            latest.Rename(title, _clock.GetUtcNow());
        }
        catch (ArgumentException ex)
        {
            _logger.LogWarning(ex,
                "Generated title rejected by domain for session {SessionId}", sessionId);
            return;
        }

        try
        {
            await _db.SaveChangesAsync(ct).ConfigureAwait(false);
            _logger.LogInformation(
                "Auto-titled chat session {SessionId} ({TitleLength} chars)",
                sessionId, title.Length);
        }
        catch (DbUpdateConcurrencyException ex)
        {
            _logger.LogDebug(ex,
                "Concurrency on title save for session {SessionId}", sessionId);
        }
    }

    /// <summary>
    /// Clamp + strip a raw LLM title into something the domain's
    /// <see cref="ChatSession.Rename"/> will accept. Strips leading /
    /// trailing quotes and collapses whitespace; enforces
    /// <see cref="ChatSession.TitleMaxLength"/>.
    /// </summary>
    internal static string NormaliseTitle(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        var trimmed = raw.Trim();

        // Some LLMs wrap the title in quotes — strip one level.
        if (trimmed.Length >= 2)
        {
            char first = trimmed[0];
            char last = trimmed[^1];
            if ((first == '"' && last == '"') || (first == '\'' && last == '\''))
                trimmed = trimmed[1..^1].Trim();
        }

        // Collapse newlines + multiple spaces — titles stay one line.
        var collapsed = new System.Text.StringBuilder(trimmed.Length);
        bool lastWasSpace = false;
        foreach (var c in trimmed)
        {
            if (char.IsWhiteSpace(c))
            {
                if (!lastWasSpace) collapsed.Append(' ');
                lastWasSpace = true;
            }
            else
            {
                collapsed.Append(c);
                lastWasSpace = false;
            }
        }

        var result = collapsed.ToString().Trim();
        if (result.Length > ChatSession.TitleMaxLength)
            result = result[..ChatSession.TitleMaxLength].TrimEnd();
        return result;
    }
}
