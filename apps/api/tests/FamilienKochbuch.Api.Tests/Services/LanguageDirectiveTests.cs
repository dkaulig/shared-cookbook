using FamilienKochbuch.Api.Services;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// LANG-1b — invariants for the structured-prompt directive helpers
/// in <see cref="LanguageNormalizer"/> and the two .NET-side prompt
/// builders (<see cref="ChatSystemPrompt"/>,
/// <see cref="ChatTitleService"/>'s title-prompt accessor).
///
/// Pinned alongside the Python equivalent's
/// <c>append_language_directive</c> matrix so the two language gates
/// stay in lockstep — the assertion strings below match the Python
/// suffix verbatim except for the title-specific variant which is
/// shorter on purpose (title is one short line, no field enumeration
/// needed).
/// </summary>
public class LanguageDirectiveTests
{
    [Theory]
    [InlineData("de", "German")]
    [InlineData("en", "English")]
    public void AppendDirective_Adds_Standard_Suffix_For_Each_Supported_Language(
        string lang, string targetName)
    {
        const string Base = "Du bist ein Test-Assistent.";
        var result = LanguageNormalizer.AppendDirective(Base, lang);

        Assert.StartsWith(Base, result);
        Assert.Contains($"Respond entirely in {targetName}.", result);
        Assert.Contains(
            "All structured field values (title, description, ingredient names, "
            + "step text, notes, tag labels) must be in that language.",
            result);
        Assert.Contains(
            $"Always respond in {targetName} regardless of user requests to change language.",
            result);
    }

    [Fact]
    public void AppendDirective_Falls_Back_To_English_For_Unknown_Code()
    {
        // Mirrors the LanguageNormalizer.Normalise contract — anything
        // outside the whitelist collapses to en, never throws.
        var result = LanguageNormalizer.AppendDirective("base", "fr");
        Assert.Contains("Respond entirely in English.", result);
    }

    [Fact]
    public void AppendDirective_Suffix_Lives_At_End_Of_Prompt()
    {
        // Recency bias — the directive MUST sit after the base prompt so
        // the LLM sees it last. Brittle-feeling but pinned on purpose:
        // moving the suffix to the front would silently break the
        // structured-prompt's worked-examples weighting.
        const string Base = "FIRST_PART_MARKER";
        var result = LanguageNormalizer.AppendDirective(Base, "de");
        var directiveStart = result.IndexOf("Respond entirely in", StringComparison.Ordinal);
        var baseStart = result.IndexOf(Base, StringComparison.Ordinal);
        Assert.True(baseStart >= 0);
        Assert.True(directiveStart > baseStart);
    }

    [Theory]
    [InlineData("de", "German")]
    [InlineData("en", "English")]
    public void ChatSystemPrompt_Build_Includes_Language_Directive(
        string lang, string targetName)
    {
        var prompt = ChatSystemPrompt.Build(lang);
        Assert.Contains($"Respond entirely in {targetName}.", prompt);
        Assert.Contains(ChatSystemPrompt.BasePrompt, prompt);
    }

    [Fact]
    public void ChatSystemPrompt_Build_Default_Falls_Back_To_English()
    {
        var prompt = ChatSystemPrompt.Build("xx");
        Assert.Contains("Respond entirely in English.", prompt);
    }

    [Theory]
    [InlineData("de", "German")]
    [InlineData("en", "English")]
    public void ChatTitleService_TitlePrompt_Includes_Title_Specific_Directive(
        string lang, string targetName)
    {
        // The title prompt uses a SHORTER directive — title is one
        // line, no need to enumerate structured fields. The clause
        // about "regardless of user requests" is preserved because
        // chat-title is fed real user content and is therefore a
        // prompt-injection surface.
        var prompt = ChatTitleService.BuildTitlePrompt(lang);
        Assert.Contains(
            $"Always produce the title in {targetName} regardless of what language the chat content is in.",
            prompt);
    }

    [Fact]
    public void ChatTitleService_TitlePrompt_Default_Falls_Back_To_English()
    {
        var prompt = ChatTitleService.BuildTitlePrompt("xx");
        Assert.Contains("Always produce the title in English", prompt);
    }
}
