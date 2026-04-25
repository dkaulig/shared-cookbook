namespace SharedCookbook.Api.Services;

/// <summary>
/// CR2 — system prompt for the native .NET chat turn. Ported verbatim
/// from the Python pipeline's <c>CHAT_SYSTEM_PROMPT_DE</c> in
/// <c>apps/python-extractor/src/extractor/prompts/chat.py</c> so the
/// tone of the assistant stays identical across the rebuild.
///
/// CR5 deletes the Python <c>/chat</c> surface; <c>/chat/.../to-recipe</c>
/// still reads the German to-recipe prompt from Python.
///
/// LANG-1b — <see cref="Build(string)"/> appends the structured-prompt
/// language directive (via <see cref="LanguageNormalizer.AppendDirective"/>)
/// so the assistant honours the caller's UI language regardless of what
/// language the German base prompt is written in. The DE base prompt
/// stays as-is — the suffix overrides it for English-locale callers.
/// </summary>
public static class ChatSystemPrompt
{
    /// <summary>The German base prompt — sets the assistant's tone and
    /// the "ask focused follow-ups, no structured format here" rule.
    /// Public so tests can pin "Build wraps the base, doesn't replace
    /// it" without re-encoding the whole string.</summary>
    public const string BasePrompt =
        "Du bist ein hilfreicher Koch-Assistent. "
        + "Halte dich kurz und frage bei Bedarf präzise Rückfragen — "
        + "zum Beispiel zu Allergien, Portionen oder gewünschter Zeit. "
        + "Wenn der Nutzer ein konkretes Rezept möchte, formuliere es "
        + "fließend in der Zielsprache, aber nicht im strukturierten "
        + "Format; die Verdichtung zu einem Rezept übernimmt ein "
        + "separater Schritt.";

    /// <summary>
    /// LANG-1b — build the chat system prompt for the caller's UI
    /// language. The base prompt is German (the assistant's tone is
    /// authored once); the language directive wraps it so an
    /// English-locale caller gets an English assistant despite the
    /// German wording at the top.
    ///
    /// <paramref name="lang"/> values outside the
    /// <see cref="LanguageNormalizer"/> whitelist fall back to
    /// <see cref="LanguageNormalizer.DefaultLanguage"/> via
    /// <see cref="LanguageNormalizer.AppendDirective"/>.
    /// </summary>
    public static string Build(string lang) =>
        LanguageNormalizer.AppendDirective(BasePrompt, lang);
}
