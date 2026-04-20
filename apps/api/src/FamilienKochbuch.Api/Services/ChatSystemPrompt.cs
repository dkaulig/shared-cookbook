namespace FamilienKochbuch.Api.Services;

/// <summary>
/// CR2 — system prompt for the native .NET chat turn. Ported verbatim
/// from the Python pipeline's <c>CHAT_SYSTEM_PROMPT_DE</c> in
/// <c>apps/python-extractor/src/extractor/prompts/chat.py</c> so the
/// tone of the assistant stays identical across the rebuild.
///
/// CR5 deletes the Python <c>/chat</c> surface; <c>/chat/.../to-recipe</c>
/// still reads the German to-recipe prompt from Python.
/// </summary>
public static class ChatSystemPrompt
{
    /// <summary>The single prompt. Plain string constant so
    /// <c>ChatEndpoints</c> can prepend it to the message array with
    /// zero allocation per turn.</summary>
    public const string Prompt =
        "Du bist ein hilfreicher Koch-Assistent. "
        + "Halte dich kurz und frage bei Bedarf präzise Rückfragen — "
        + "zum Beispiel zu Allergien, Portionen oder gewünschter Zeit. "
        + "Wenn der Nutzer ein konkretes Rezept möchte, formuliere es "
        + "fließend in deutscher Sprache, aber nicht im strukturierten "
        + "Format; die Verdichtung zu einem Rezept übernimmt ein "
        + "separater Schritt.";

    /// <summary>Accessor retained for test discoverability — a method
    /// reads naturally at the call-site and survives a future move to
    /// per-user / localised prompt building without breaking callers.
    /// </summary>
    public static string Build() => Prompt;
}
