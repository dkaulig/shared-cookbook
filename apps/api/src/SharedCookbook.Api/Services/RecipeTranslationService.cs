using System.Text.Json;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Ai;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace SharedCookbook.Api.Services;

/// <summary>
/// LANG-2 — on-demand recipe re-translation. Caches one translation row
/// per <c>(recipeId, language)</c> pair via
/// <see cref="Domain.Entities.RecipeTranslation"/>; serves cached
/// payloads on repeat hits and refreshes them via the Azure OpenAI
/// chat-completion endpoint when missing or when the user explicitly
/// asks for a refresh.
///
/// <para>
/// Stale-cascade is handled at the <em>recipe-update</em> sites
/// (PUT /api/recipes/:id, the reimport job) via
/// <see cref="MarkAllStaleAsync"/>. The service itself doesn't subscribe
/// to recipe updates — there's no domain-event infrastructure in this
/// codebase, so we use direct service calls (consistent with
/// <see cref="Infrastructure.Services.RecipeRevisionService"/>).
/// </para>
/// </summary>
public sealed class RecipeTranslationService
{
    private readonly AppDbContext _db;
    private readonly IAzureOpenAIChatClient _llm;
    private readonly TimeProvider _clock;
    private readonly ILogger<RecipeTranslationService> _logger;

    public RecipeTranslationService(
        AppDbContext db,
        IAzureOpenAIChatClient llm,
        TimeProvider clock,
        ILogger<RecipeTranslationService> logger)
    {
        _db = db;
        _llm = llm;
        _clock = clock;
        _logger = logger;
    }

    /// <summary>
    /// Result of a translate call. Either a successful payload or a
    /// shape that maps directly to the endpoint's error response.
    /// </summary>
    public sealed record TranslateResult(
        string TranslatedPayload,
        bool IsStale,
        bool CacheHit,
        Failure? Error)
    {
        public bool IsSuccess => Error is null;
    }

    public sealed record Failure(string Code, string Message);

    /// <summary>
    /// Translate the recipe identified by <paramref name="recipeId"/>
    /// into <paramref name="targetLanguage"/>.
    ///
    /// Cache flow:
    /// <list type="number">
    /// <item>If <paramref name="targetLanguage"/> equals the recipe's
    /// <see cref="Recipe.SourceLanguage"/>, return
    /// <c>already_in_language</c> failure.</item>
    /// <item>If a non-stale row exists, return it (cache hit).</item>
    /// <item>If a stale row exists and <paramref name="force"/> is
    /// <c>false</c>, return the stale payload + <c>IsStale = true</c>.
    /// The frontend renders the "Aktualisieren" affordance.</item>
    /// <item>Otherwise (no row, OR stale + force), call the LLM, persist
    /// the result, and return the fresh payload.</item>
    /// </list>
    /// </summary>
    public async Task<TranslateResult> TranslateAsync(
        Guid recipeId,
        string targetLanguage,
        bool force,
        CancellationToken ct)
    {
        var recipe = await _db.Recipes
            .Include(r => r.Components)
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .FirstOrDefaultAsync(r => r.Id == recipeId && r.DeletedAt == null, ct)
            .ConfigureAwait(false);
        if (recipe is null)
        {
            return new TranslateResult(string.Empty, false, false,
                new Failure(ErrorCodes.RecipeNotFound, "Recipe not found."));
        }

        if (string.Equals(targetLanguage, recipe.SourceLanguage, StringComparison.OrdinalIgnoreCase))
        {
            return new TranslateResult(string.Empty, false, false,
                new Failure(ErrorCodes.AlreadyInLanguage,
                    "Target language equals the recipe's source language."));
        }

        var existing = await _db.RecipeTranslations
            .FirstOrDefaultAsync(t => t.RecipeId == recipeId && t.Language == targetLanguage, ct)
            .ConfigureAwait(false);

        // Cache hit (fresh) — return.
        if (existing is not null && !existing.IsStale)
        {
            return new TranslateResult(
                existing.TranslatedPayload, IsStale: false, CacheHit: true, Error: null);
        }

        // Stale + no force — serve stale, let the frontend prompt for refresh.
        if (existing is not null && existing.IsStale && !force)
        {
            return new TranslateResult(
                existing.TranslatedPayload, IsStale: true, CacheHit: true, Error: null);
        }

        // Cache miss OR stale-with-force — call the LLM.
        var tagIds = recipe.RecipeTags.Select(rt => rt.TagId).ToArray();
        var tags = tagIds.Length == 0
            ? Array.Empty<Tag>()
            : await _db.Tags
                .Where(t => tagIds.Contains(t.Id))
                .ToArrayAsync(ct)
                .ConfigureAwait(false);

        var (systemPrompt, userPrompt) = RecipeTranslationPrompt.Build(
            recipe, tags, targetLanguage);

        string llmResponse;
        try
        {
            llmResponse = await _llm.CompleteAsync(
                new[]
                {
                    new ChatCompletionMessage("system", systemPrompt),
                    new ChatCompletionMessage("user", userPrompt),
                },
                ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Recipe translation LLM call failed recipeId={RecipeId} lang={Lang}",
                recipeId, targetLanguage);
            return new TranslateResult(string.Empty, false, false,
                new Failure(ErrorCodes.AiServiceUnavailable,
                    "Translation service is currently unavailable."));
        }

        if (!IsValidTranslationJson(llmResponse))
        {
            _logger.LogWarning(
                "Recipe translation returned malformed JSON recipeId={RecipeId} lang={Lang} len={Len}",
                recipeId, targetLanguage, llmResponse?.Length ?? 0);
            return new TranslateResult(string.Empty, false, false,
                new Failure(ErrorCodes.AiServiceUnavailable,
                    "Translation result was malformed."));
        }

        // Persist (insert OR refresh-existing).
        var now = _clock.GetUtcNow();
        if (existing is null)
        {
            var fresh = new RecipeTranslation(recipeId, targetLanguage, llmResponse, now);
            _db.RecipeTranslations.Add(fresh);
        }
        else
        {
            existing.Refresh(llmResponse, now);
        }

        try
        {
            await _db.SaveChangesAsync(ct).ConfigureAwait(false);
        }
        catch (DbUpdateException ex)
        {
            // A concurrent translate call lost the race on the unique
            // index. Re-read the row and serve whatever's there. This
            // path is exceedingly rare; the user pays one extra LLM call
            // worth of tokens, no data loss.
            _logger.LogDebug(ex,
                "Concurrent translate race recipeId={RecipeId} lang={Lang}",
                recipeId, targetLanguage);
            var current = await _db.RecipeTranslations.AsNoTracking()
                .FirstOrDefaultAsync(t => t.RecipeId == recipeId && t.Language == targetLanguage, ct)
                .ConfigureAwait(false);
            if (current is null)
            {
                return new TranslateResult(string.Empty, false, false,
                    new Failure(ErrorCodes.InternalError, "Translation save failed."));
            }
            return new TranslateResult(
                current.TranslatedPayload, current.IsStale, CacheHit: true, Error: null);
        }

        return new TranslateResult(llmResponse, IsStale: false, CacheHit: false, Error: null);
    }

    /// <summary>
    /// LANG-2 stale-cascade — flag every translation of the given
    /// recipe stale. Called from each recipe-update endpoint inside the
    /// same EF transaction so the cascade lands atomically with the
    /// edit. No-op when the recipe has no translations.
    /// </summary>
    public async Task MarkAllStaleAsync(Guid recipeId, CancellationToken ct)
    {
        var translations = await _db.RecipeTranslations
            .Where(t => t.RecipeId == recipeId)
            .ToListAsync(ct)
            .ConfigureAwait(false);
        foreach (var t in translations)
        {
            t.MarkStale();
        }
        // Caller owns SaveChanges so the stale-cascade lands inside the
        // same transaction as the source-recipe edit.
    }

    /// <summary>
    /// Best-effort schema check — guards against an LLM that ignored
    /// the JSON-only directive. Full schema validation lives at render
    /// time on the frontend (the fields are merged onto the source
    /// recipe shape, where missing keys fall back to the original
    /// content).
    /// </summary>
    internal static bool IsValidTranslationJson(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return false;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            return doc.RootElement.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
