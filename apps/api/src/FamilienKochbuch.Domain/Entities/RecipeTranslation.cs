namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// LANG-2 — cached translation of a <see cref="Recipe"/> into a non-source
/// UI language (today: <c>"de"</c> ↔ <c>"en"</c>; LANG-4 widens the set).
/// One row per <c>(RecipeId, Language)</c> pair; the
/// <see cref="TranslatedPayload"/> column carries the full nested
/// translated shape as JSON so a translate-then-render hit doesn't need
/// to re-walk the recipe aggregate.
///
/// <para>
/// The <see cref="IsStale"/> flag guards against stale translations after
/// a recipe edit: every recipe-update endpoint flips
/// <see cref="IsStale"/> to <c>true</c> in the same transaction. The
/// detail page surfaces the stale state with a "Übersetzung könnte
/// veraltet sein" hint + a "Aktualisieren" link that re-runs the
/// translation. The user decides whether to refresh; we don't auto-bust
/// the cache.
/// </para>
///
/// <para>
/// Soft-deleted recipes leave their translation rows intact (FK cascade
/// only fires on hard-delete). The translation rows are meaningless once
/// the recipe is gone but harmless — they get swept whenever a future
/// hard-delete pass runs.
/// </para>
/// </summary>
public class RecipeTranslation
{
    public const int LanguageMaxLength = 2;

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private RecipeTranslation() { }

    /// <summary>
    /// Create a fresh, non-stale translation row. Callers (the
    /// translation service) build the row after a successful LLM call;
    /// the row is only persisted with <see cref="IsStale"/> = <c>true</c>
    /// when an existing one had <see cref="MarkStale"/> called between
    /// the cache-miss and the LLM-call (a concurrent recipe-edit).
    /// </summary>
    public RecipeTranslation(
        Guid recipeId,
        string language,
        string translatedPayload,
        DateTimeOffset updatedAt)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        var normalizedLanguage = ValidateLanguage(language);
        if (string.IsNullOrWhiteSpace(translatedPayload))
            throw new ArgumentException(
                "Translated payload must not be blank.", nameof(translatedPayload));

        Id = Guid.NewGuid();
        RecipeId = recipeId;
        Language = normalizedLanguage;
        TranslatedPayload = translatedPayload;
        UpdatedAt = updatedAt;
        IsStale = false;
    }

    public Guid Id { get; private set; }
    public Guid RecipeId { get; private set; }

    /// <summary>Two-letter ISO language code (lowercase). Whitelist
    /// matches <see cref="Recipe.SourceLanguage"/>.</summary>
    public string Language { get; private set; } = string.Empty;

    /// <summary>JSON document carrying the full nested translated
    /// shape — Postgres column type is <c>jsonb</c>, kept as
    /// <see cref="string"/> here so the Domain assembly stays
    /// dependency-free.</summary>
    public string TranslatedPayload { get; private set; } = string.Empty;

    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>
    /// Set to <c>true</c> by <see cref="MarkStale"/> when the source
    /// recipe's translatable fields change. The cached payload is still
    /// served (so the user doesn't pay the LLM cost on every detail-page
    /// load), and the frontend renders an inline hint with a refresh
    /// affordance.
    /// </summary>
    public bool IsStale { get; private set; }

    /// <summary>
    /// Mark this translation as stale. Idempotent — calling it a second
    /// time after a stale row is already flagged is a no-op. Called from
    /// each recipe-update endpoint inside the same EF transaction so the
    /// flag and the source edit land atomically.
    /// </summary>
    public void MarkStale()
    {
        IsStale = true;
    }

    /// <summary>
    /// Replace the cached payload with a freshly-translated one. Bumps
    /// <see cref="UpdatedAt"/> and clears <see cref="IsStale"/>.
    /// </summary>
    public void Refresh(string translatedPayload, DateTimeOffset updatedAt)
    {
        if (string.IsNullOrWhiteSpace(translatedPayload))
            throw new ArgumentException(
                "Translated payload must not be blank.", nameof(translatedPayload));

        TranslatedPayload = translatedPayload;
        UpdatedAt = updatedAt;
        IsStale = false;
    }

    private static string ValidateLanguage(string language)
    {
        if (string.IsNullOrWhiteSpace(language))
            throw new ArgumentException(
                "Language must not be blank.", nameof(language));
        var normalized = language.Trim().ToLowerInvariant();
        if (normalized != "de" && normalized != "en")
            throw new ArgumentException(
                "Language must be one of: de, en.", nameof(language));
        return normalized;
    }
}
