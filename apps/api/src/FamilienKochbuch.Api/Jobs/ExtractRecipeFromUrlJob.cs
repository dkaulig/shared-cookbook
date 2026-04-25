using System.Text.Json;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// Hangfire job that drives a URL-based recipe extraction end-to-end.
///
/// Two modes:
/// <list type="bullet">
/// <item><b>New-import</b> (default): the job lets the Python pipeline
/// extract a fresh recipe; the frontend's review-flow ultimately calls
/// <c>POST /api/recipes</c> to insert a new row.</item>
/// <item><b>Reimport</b> (REIMPORT-0): when <see cref="RecipeImport.TargetRecipeId"/>
/// is set, the job loads that recipe and overwrites its mutable body
/// in place via <see cref="Recipe.UpdateFromImport"/>. No new row is
/// created, photos/ratings/last-cooked history are preserved.</item>
/// </list>
///
/// Transport + progress + retry live on <see cref="PythonExtractorRunner"/>.
/// The <c>[AutomaticRetry]</c> attribute with <c>Attempts = 3</c> covers
/// transient 5xx + network errors only; terminal 4xx errors throw with
/// <see cref="PythonExtractorException.IsTerminal"/>=true so Hangfire
/// stops retrying.
/// </summary>
[AutomaticRetry(Attempts = 3)]
public class ExtractRecipeFromUrlJob
{
    /// <summary>Named HttpClient registered against the Python service.</summary>
    public const string HttpClientName = "python-extractor";

    /// <summary>
    /// REIMPORT-0 — error code stored on <see cref="RecipeImport.ErrorMessage"/>
    /// when the reimport's target was deleted between enqueue and run.
    /// The frontend surfaces this verbatim in the progress-page error
    /// banner with German copy; kept as a code here so the web layer
    /// owns the exact wording.
    /// </summary>
    public const string RecipeDeletedErrorCode = "recipe_deleted";

    private readonly AppDbContext _db;
    private readonly PythonExtractorRunner _runner;
    private readonly CandidateAttacher _candidateAttacher;
    private readonly IPhotoStorage _photoStorage;
    private readonly TimeProvider _clock;
    private readonly ILogger<ExtractRecipeFromUrlJob> _logger;
    private readonly Services.RecipeTranslationService _translationService;

    public ExtractRecipeFromUrlJob(
        AppDbContext db,
        PythonExtractorRunner runner,
        CandidateAttacher candidateAttacher,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger<ExtractRecipeFromUrlJob> logger,
        Services.RecipeTranslationService translationService)
    {
        _db = db;
        _runner = runner;
        _candidateAttacher = candidateAttacher;
        _photoStorage = photoStorage;
        _clock = clock;
        _logger = logger;
        _translationService = translationService;
    }

    /// <summary>Entry point invoked by Hangfire. Public for EF's DI
    /// integration; callers outside Hangfire should go through
    /// <c>BackgroundJob.Enqueue&lt;ExtractRecipeFromUrlJob&gt;(j =&gt;
    /// j.ExecuteAsync(importId, CancellationToken.None))</c>.</summary>
    public async Task ExecuteAsync(Guid importId, CancellationToken ct)
    {
        var import = await _db.RecipeImports.SingleOrDefaultAsync(i => i.Id == importId, ct)
            ?? throw new InvalidOperationException(
                $"RecipeImport {importId} not found; was it deleted before the job ran?");

        if (import.Source != ImportSource.Url)
            throw new InvalidOperationException(
                $"RecipeImport {importId} has source {import.Source}; expected Url.");

        if (string.IsNullOrWhiteSpace(import.SourceUrl))
            throw new InvalidOperationException(
                $"RecipeImport {importId} has no SourceUrl; cannot dispatch URL extraction.");

        // REIMPORT-0 — the target-existence guard runs BEFORE the
        // Python call so a deleted-since-enqueue recipe short-circuits
        // without paying for Whisper/Azure tokens. If the recipe is
        // gone the import lands in Error with `recipe_deleted`.
        if (import.TargetRecipeId is Guid targetId)
        {
            var exists = await _db.Recipes
                .AsNoTracking()
                .AnyAsync(r => r.Id == targetId && r.DeletedAt == null, ct);
            if (!exists)
            {
                import.MarkError(RecipeDeletedErrorCode, _clock.GetUtcNow());
                await _db.SaveChangesAsync(ct);
                return;
            }
        }

        await _runner.RunAsync(
            import,
            relativeUrl: "/extract/url",
            buildBody: i => new
            {
                url = i.SourceUrl,
                hint = new { group_id = i.GroupId.ToString("D"), user_id = i.UserId.ToString("D") },
            },
            ct);

        // REIMPORT-0 — on success, apply the fresh extraction result
        // onto the existing recipe row rather than letting the PF1
        // promote-flow insert a new one. Photos are preserved, with
        // opportunistic auto-attach of a new thumbnail (dedupe by URL).
        //
        // Load the target AFTER the runner's SaveChanges cycle so
        // there's no risk of a stale concurrency token from the
        // multiple import-row UPDATEs the runner issues during
        // progress reporting.
        if (import.TargetRecipeId is Guid postTargetId
            && import.Status == ImportStatus.Done
            && !string.IsNullOrWhiteSpace(import.ResultJson))
        {
            var targetRecipe = await _db.Recipes
                .Include(r => r.Components)
                .Include(r => r.Ingredients)
                .Include(r => r.Steps)
                .Include(r => r.RecipeTags)
                .FirstOrDefaultAsync(r => r.Id == postTargetId && r.DeletedAt == null, ct);
            if (targetRecipe is null)
            {
                // Deleted during extraction — import is Done but apply
                // is a no-op. We can't flip Done→Error per the domain
                // invariants, so the row stays Done with ResultJson set
                // (the frontend detects recipe-not-found on redirect).
                return;
            }
            await ApplyReimportAsync(import, targetRecipe, ct);
            return;
        }

        // COVER-0 — standard new-import path: download every
        // candidate thumbnail the extractor emitted and stage one row
        // per success. Idempotent on a Hangfire retry that lands here
        // after the previous attempt already attached candidates.
        if (import.Status == ImportStatus.Done
            && import.CandidateStagedPhotoIds.Length == 0
            && !string.IsNullOrWhiteSpace(import.ResultJson))
        {
            var urls = ExtractCandidateUrls(import.ResultJson);
            if (urls.Count > 0)
            {
                var stagedIds = await _candidateAttacher.DownloadAndStageAsync(
                    import.UserId, import.Id, urls, import.SourceUrl, ct);
                if (stagedIds.Length > 0)
                {
                    import.AttachCandidateStagedPhotos(stagedIds);
                    await _db.SaveChangesAsync(ct);
                }
            }
        }
    }

    /// <summary>
    /// COVER-0 — reads the ordered candidate-thumbnail URL list out of
    /// the Python extractor's structured result JSON. Returns an empty
    /// list when the field is absent or malformed.
    /// </summary>
    internal static List<string> ExtractCandidateUrls(string resultJson)
    {
        var urls = new List<string>();
        if (string.IsNullOrWhiteSpace(resultJson)) return urls;

        using var doc = JsonDocument.Parse(resultJson);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return urls;
        if (!doc.RootElement.TryGetProperty("recipe", out var recipe)
            || recipe.ValueKind != JsonValueKind.Object)
        {
            return urls;
        }

        if (recipe.TryGetProperty("candidate_thumbnails", out var candidates)
            && candidates.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in candidates.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.String) continue;
                var raw = entry.GetString();
                if (!string.IsNullOrWhiteSpace(raw)) urls.Add(raw);
            }
        }

        return urls;
    }

    /// <summary>
    /// REIMPORT-0 — parses the extractor's ResultJson and overwrites
    /// the target recipe's mutable body in place. Ingredients / steps /
    /// AI-tags replaced; Custom tags preserved by the domain method;
    /// existing photos preserved. BUG-048: a thumbnail URL on the fresh
    /// result is downloaded, staged, and promoted onto the recipe's
    /// Photos unless a previous reimport already promoted a StagedPhoto
    /// with the same SourceUrl to this recipe (dedupe-by-origin).
    /// </summary>
    private async Task ApplyReimportAsync(
        RecipeImport import, Recipe target, CancellationToken ct)
    {
        var parsed = ReimportResultParser.Parse(import.ResultJson!);

        // Resolve the AI-tag Tag entities the domain method needs for
        // the name→id lookup. Global seeded tags live at
        // CreatedByUserId/GroupId NULL; we also pull whatever tags the
        // recipe already carries so the domain method can classify
        // existing Custom vs AI rows.
        var existingTagIds = target.RecipeTags.Select(rt => rt.TagId).ToArray();
        var normalizedAiNames = parsed.TagNames
            .Select(n => n.Trim())
            .Where(n => n.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var candidateTags = await _db.Tags
            .Where(t => existingTagIds.Contains(t.Id)
                || (t.GroupId == null && normalizedAiNames.Contains(t.Name)))
            .ToListAsync(ct);

        // COMP-0 — two-phase clear-then-replace, mirroring
        // UpdateRecipeAsync. The domain method first runs the aggregate
        // invariants on the fresh component tree; we detach the nav
        // collections immediately after so the two-phase write can
        // DELETE old rows + INSERT new ones without EF re-sending the
        // whole aggregate as modified.
        var newComponents = new List<RecipeComponent>();
        var newIngredients = new List<Ingredient>();
        var newSteps = new List<RecipeStep>();
        foreach (var parsedComponent in parsed.Components)
        {
            var component = new RecipeComponent(
                recipeId: target.Id,
                position: parsedComponent.Position,
                label: parsedComponent.Label);
            newComponents.Add(component);

            foreach (var ing in parsedComponent.Ingredients.Select((v, idx) => (v, idx)))
            {
                newIngredients.Add(new Ingredient(
                    recipeId: target.Id,
                    componentId: component.Id,
                    position: ing.idx,
                    quantity: ing.v.Quantity,
                    unit: ing.v.Unit,
                    name: ing.v.Name,
                    note: ing.v.Note,
                    scalable: ing.v.Scalable));
            }
            foreach (var step in parsedComponent.Steps.Select((v, idx) => (v, idx)))
            {
                newSteps.Add(new RecipeStep(
                    recipeId: target.Id,
                    componentId: component.Id,
                    position: step.idx,
                    content: step.v.Content));
            }
        }

        // Domain validation + tag merge via UpdateFromImport. The method
        // delegates to ReplaceComponents for the ≥1-component /
        // unique-position / FK invariants; it also writes Title,
        // Description, Nutrition, and bumps Version exactly once.
        var now = _clock.GetUtcNow();
        target.UpdateFromImport(
            title: parsed.Title,
            description: parsed.Description,
            defaultServings: parsed.Servings,
            prepTimeMinutes: parsed.PrepMinutes,
            cookTimeMinutes: parsed.CookMinutes,
            difficulty: parsed.Difficulty,
            newComponents: newComponents,
            newIngredients: newIngredients,
            newSteps: newSteps,
            newAiTagNames: normalizedAiNames,
            existingAndNewTags: candidateTags,
            nutrition: parsed.Nutrition,
            now: now);

        // Snapshot the freshly-validated navigation state, then clear
        // the aggregate's collections so the two-phase write can DELETE
        // the pre-existing child rows without EF trying to re-send the
        // new ones as part of the Recipe UPDATE batch.
        var mergedTagLinks = target.RecipeTags.ToArray();
        target.Components.Clear();
        target.Ingredients.Clear();
        target.Steps.Clear();
        target.RecipeTags.Clear();

        // Phase 1 — DELETE the pre-existing Ingredient / Step / Component
        // / RecipeTag rows. Ingredient + Step FK-depend on Component so
        // they go first. The Recipe-level UPDATE carries the Version
        // concurrency-token bump + the new metadata.
        var existingIngredients = await _db.Ingredients
            .Where(i => i.RecipeId == target.Id)
            .ToListAsync(ct);
        _db.Ingredients.RemoveRange(existingIngredients);
        var existingSteps = await _db.RecipeSteps
            .Where(s => s.RecipeId == target.Id)
            .ToListAsync(ct);
        _db.RecipeSteps.RemoveRange(existingSteps);
        var existingComponents = await _db.RecipeComponents
            .Where(c => c.RecipeId == target.Id)
            .ToListAsync(ct);
        _db.RecipeComponents.RemoveRange(existingComponents);
        var existingRecipeTags = await _db.RecipeTags
            .Where(rt => rt.RecipeId == target.Id)
            .ToListAsync(ct);
        _db.RecipeTags.RemoveRange(existingRecipeTags);
        await _db.SaveChangesAsync(ct);

        // Phase 2 — INSERT the fresh Component + Ingredient + Step +
        // RecipeTag rows via the DbSet so EF doesn't re-emit the
        // Recipe row.
        foreach (var component in newComponents)
            _db.RecipeComponents.Add(component);
        foreach (var ingredient in newIngredients)
            _db.Ingredients.Add(ingredient);
        foreach (var step in newSteps)
            _db.RecipeSteps.Add(step);
        foreach (var tagLink in mergedTagLinks)
            _db.RecipeTags.Add(tagLink);

        // LANG-2 — stale-cascade for the reimport path. Recipe body got
        // wholesale-replaced by UpdateFromImport; every cached
        // translation row is now potentially stale. Mark them and let
        // the user decide whether to refresh on next detail-page load.
        // No-op when no translations exist (the common case for a
        // freshly-imported recipe).
        await _translationService.MarkAllStaleAsync(target.Id, ct);

        await _db.SaveChangesAsync(ct);

        // COVER-0 — download every candidate thumbnail the extractor
        // emitted, stage them linked to this import, and (when a fresh
        // default cover survives the dedupe) promote [0] onto the
        // recipe's Photos. The non-default candidates stay unpromoted
        // and surface through the "Cover ändern" flow on the recipe
        // detail page until the sweep reaps them.
        var urls = ExtractCandidateUrls(import.ResultJson!);
        if (urls.Count == 0) return;

        // Dedupe by URL: a previous reimport may already have promoted
        // a StagedPhoto from one of these URLs. Skip every URL whose
        // (PromotedToRecipeId, SourceUrl) key already exists so a
        // frequent reimport doesn't bloat storage with duplicates. The
        // (PromotedToRecipeId, SourceUrl) index makes the lookup cheap.
        var alreadyPromotedUrls = await _db.StagedPhotos
            .AsNoTracking()
            .Where(s => s.PromotedToRecipeId == target.Id
                && s.SourceUrl != null
                && urls.Contains(s.SourceUrl))
            .Select(s => s.SourceUrl!)
            .ToListAsync(ct);
        var freshUrls = urls.Where(u => !alreadyPromotedUrls.Contains(u)).ToList();
        if (freshUrls.Count == 0) return;

        var stagedIds = await _candidateAttacher.DownloadAndStageAsync(
            import.UserId, import.Id, freshUrls, import.SourceUrl, ct);
        if (stagedIds.Length == 0) return;

        import.AttachCandidateStagedPhotos(stagedIds);
        await _db.SaveChangesAsync(ct);

        // Promote the first fresh candidate onto the recipe's Photos so
        // the detail page renders the new hero immediately. The rest stay
        // un-promoted as alternative candidates for the "Cover ändern"
        // flow until the 7-day sweep reaps them.
        await PromoteThumbnailOntoRecipeAsync(target, stagedIds[0], ct);
    }

    /// <summary>
    /// BUG-048 — mirrors the create-recipe promote-flow for a staged
    /// photo the attacher just produced during a reimport. Copies the
    /// blob into the recipe namespace, appends the destination path to
    /// <see cref="Recipe.Photos"/>, marks the <see cref="StagedPhoto"/>
    /// as promoted, and fires a best-effort cleanup of the source
    /// staged blob.
    ///
    /// Failure modes are logged-and-swallowed: a storage-copy error or
    /// a <see cref="Recipe.MaxPhotos"/> overflow on the recipe must not
    /// fail the whole reimport — the extractor's body/metadata changes
    /// are already persisted and the user's recipe is in a valid state
    /// without the new thumbnail.
    /// </summary>
    private async Task PromoteThumbnailOntoRecipeAsync(
        Recipe target, Guid stagedPhotoId, CancellationToken ct)
    {
        var staged = await _db.StagedPhotos
            .FirstOrDefaultAsync(s => s.Id == stagedPhotoId, ct);
        if (staged is null)
        {
            // Shouldn't happen — TryAttachAsync just inserted the row
            // and SaveChanges'd. Guard is defensive.
            _logger.LogWarning(
                "Reimport thumbnail staged-photo {StagedPhotoId} vanished before promote; skipping.",
                stagedPhotoId);
            return;
        }

        // Photo cap: if the recipe is already full, drop the new
        // thumbnail. The staged row stays un-promoted and the hourly
        // sweep reaps it after 24 h. This is rare (user would have had
        // to manually add 3 photos before re-importing) and a hard fail
        // would be worse UX than a silent skip.
        if (target.Photos.Count >= Recipe.MaxPhotos)
        {
            _logger.LogInformation(
                "Recipe {RecipeId} is at the {Max}-photo cap; reimport thumbnail from staged {StagedPhotoId} left unpromoted.",
                target.Id, Recipe.MaxPhotos, staged.Id);
            return;
        }

        string destinationPath;
        try
        {
            destinationPath = await _photoStorage.CopyAsync(
                staged.PhotoId, staged.ContentType, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Reimport thumbnail copy from staged {StagedPhotoId} ({SourcePath}) to recipe {RecipeId} failed; skipping attach.",
                staged.Id, staged.PhotoId, target.Id);
            return;
        }

        try
        {
            target.AddPhoto(destinationPath);
            staged.MarkPromoted(target.Id, _clock.GetUtcNow());
            await _db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "Reimport thumbnail promote for staged {StagedPhotoId} -> recipe {RecipeId} failed during SaveChanges; rolling back in-memory state + deleting destination blob.",
                staged.Id, target.Id);
            // Roll back the in-memory AddPhoto so a subsequent caller
            // sees the true Photos count, and best-effort delete the
            // orphaned destination blob. The staged source stays put
            // (sweep reaps eventually).
            target.RemovePhoto(destinationPath);
            try
            {
                await _photoStorage.DeleteAsync(destinationPath, ct);
            }
            catch (Exception cleanupEx)
            {
                _logger.LogWarning(cleanupEx,
                    "Cleanup of orphaned reimport destination blob {Path} failed; sweep job will retry.",
                    destinationPath);
            }
            return;
        }

        // Best-effort delete of the staged source blob — same pattern
        // as the create-recipe promote. The sweep job reaps orphans if
        // this fails.
        try
        {
            await _photoStorage.DeleteAsync(staged.PhotoId, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Cleanup of staged source blob {Path} after reimport promote failed; sweep job will retry.",
                staged.PhotoId);
        }
    }
}

/// <summary>
/// REIMPORT-0 — pure JSON → structured-data parser for the Python
/// pipeline's <c>ExtractionResult</c>. Lives next to the job because
/// it's a job-internal concern (the frontend consumes the same JSON
/// through its own TypeScript mapper); extracting it here as a
/// separate class keeps the job method short and makes the parsing
/// rules reviewable in isolation.
/// </summary>
internal static class ReimportResultParser
{
    internal sealed record ParsedIngredient(
        string Name, decimal? Quantity, string Unit, string? Note, bool Scalable);

    internal sealed record ParsedStep(string Content);

    /// <summary>COMP-0 — one sub-recipe group inside the extractor's
    /// <c>components</c> array. <see cref="Position"/> is 0-based.</summary>
    internal sealed record ParsedComponent(
        int Position,
        string? Label,
        IReadOnlyList<ParsedIngredient> Ingredients,
        IReadOnlyList<ParsedStep> Steps);

    internal sealed record ParsedResult(
        string Title,
        string? Description,
        int? Servings,
        int? Difficulty,
        int? PrepMinutes,
        int? CookMinutes,
        IReadOnlyList<ParsedComponent> Components,
        IReadOnlyList<string> TagNames,
        string? ThumbnailUrl,
        NutritionEstimate? Nutrition);

    public static ParsedResult Parse(string resultJson)
    {
        using var doc = JsonDocument.Parse(resultJson);
        if (!doc.RootElement.TryGetProperty("recipe", out var recipe)
            || recipe.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidOperationException(
                "Extraction result has no `recipe` object; refusing to reimport blind.");
        }

        var title = GetStringOrEmpty(recipe, "title");
        if (string.IsNullOrWhiteSpace(title))
            throw new InvalidOperationException("Extraction result is missing a recipe title.");

        var description = GetNullableString(recipe, "description");
        var servings = GetNullableInt(recipe, "servings");
        var difficulty = GetNullableInt(recipe, "difficulty");
        var prepMinutes = GetNullableInt(recipe, "prep_minutes");
        var cookMinutes = GetNullableInt(recipe, "cook_minutes");
        var thumbnailUrl = GetNullableString(recipe, "thumbnail_url");

        // COMP-0 — components is the only supported shape. A flat
        // top-level `ingredients` / `steps` is a protocol violation
        // (the Python extractor emits components per the new schema).
        // Missing / empty → yields a single default component with no
        // children so the domain's ≥1-component invariant still holds.
        var components = new List<ParsedComponent>();
        if (recipe.TryGetProperty("components", out var componentsEl)
            && componentsEl.ValueKind == JsonValueKind.Array)
        {
            int fallbackPosition = 0;
            foreach (var comp in componentsEl.EnumerateArray())
            {
                var label = GetNullableString(comp, "label");
                var position = GetNullableInt(comp, "position") ?? fallbackPosition;
                fallbackPosition = position + 1;

                var compIngredients = ParseIngredients(comp);
                var compSteps = ParseSteps(comp);
                components.Add(new ParsedComponent(
                    position, label, compIngredients, compSteps));
            }
        }
        if (components.Count == 0)
        {
            components.Add(new ParsedComponent(
                0, null,
                Array.Empty<ParsedIngredient>(),
                Array.Empty<ParsedStep>()));
        }

        var tagNames = new List<string>();
        if (recipe.TryGetProperty("tags", out var tagsEl)
            && tagsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var t in tagsEl.EnumerateArray())
            {
                if (t.ValueKind == JsonValueKind.String)
                {
                    var raw = t.GetString();
                    if (!string.IsNullOrWhiteSpace(raw)) tagNames.Add(raw!.Trim().ToLowerInvariant());
                }
            }
        }

        NutritionEstimate? nutrition = null;
        if (recipe.TryGetProperty("nutrition_estimate", out var nut)
            && nut.ValueKind == JsonValueKind.Object)
        {
            var kcal = GetNullableInt(nut, "kcal");
            var protein = GetNullableInt(nut, "protein_g");
            var carbs = GetNullableInt(nut, "carbs_g");
            var fat = GetNullableInt(nut, "fat_g");
            if (kcal is not null && protein is not null && carbs is not null && fat is not null)
            {
                nutrition = new NutritionEstimate(kcal.Value, protein.Value, carbs.Value, fat.Value);
            }
        }

        return new ParsedResult(
            Title: title.Trim(),
            Description: description,
            Servings: servings,
            Difficulty: difficulty,
            PrepMinutes: prepMinutes,
            CookMinutes: cookMinutes,
            Components: components.OrderBy(c => c.Position).ToList(),
            TagNames: tagNames,
            ThumbnailUrl: thumbnailUrl,
            Nutrition: nutrition);
    }

    private static IReadOnlyList<ParsedIngredient> ParseIngredients(JsonElement owner)
    {
        var ingredients = new List<ParsedIngredient>();
        if (!owner.TryGetProperty("ingredients", out var ings)
            || ings.ValueKind != JsonValueKind.Array)
        {
            return ingredients;
        }

        foreach (var i in ings.EnumerateArray())
        {
            var name = GetStringOrEmpty(i, "name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            var unit = GetNullableString(i, "unit") ?? string.Empty;
            var note = GetNullableString(i, "note");
            var quantityText = GetNullableString(i, "quantity");
            var quantity = TryParseDecimal(quantityText);
            var scalable = quantity is > 0m;
            ingredients.Add(new ParsedIngredient(name.Trim(), quantity, unit, note, scalable));
        }
        return ingredients;
    }

    private static IReadOnlyList<ParsedStep> ParseSteps(JsonElement owner)
    {
        var steps = new List<ParsedStep>();
        if (!owner.TryGetProperty("steps", out var stepsEl)
            || stepsEl.ValueKind != JsonValueKind.Array)
        {
            return steps;
        }

        foreach (var s in stepsEl.EnumerateArray())
        {
            var content = GetStringOrEmpty(s, "content");
            if (string.IsNullOrWhiteSpace(content)) continue;
            steps.Add(new ParsedStep(content.Trim()));
        }
        return steps;
    }

    private static string GetStringOrEmpty(JsonElement obj, string key)
    {
        if (!obj.TryGetProperty(key, out var el)) return string.Empty;
        return el.ValueKind == JsonValueKind.String ? el.GetString() ?? string.Empty : string.Empty;
    }

    private static string? GetNullableString(JsonElement obj, string key)
    {
        if (!obj.TryGetProperty(key, out var el)) return null;
        if (el.ValueKind != JsonValueKind.String) return null;
        var s = el.GetString();
        return string.IsNullOrWhiteSpace(s) ? null : s;
    }

    private static int? GetNullableInt(JsonElement obj, string key)
    {
        if (!obj.TryGetProperty(key, out var el)) return null;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)) return n;
        if (el.ValueKind == JsonValueKind.String
            && int.TryParse(el.GetString(), System.Globalization.NumberStyles.Integer,
                System.Globalization.CultureInfo.InvariantCulture, out var parsed))
        {
            return parsed;
        }
        return null;
    }

    private static decimal? TryParseDecimal(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (decimal.TryParse(raw, System.Globalization.NumberStyles.Number,
                System.Globalization.CultureInfo.InvariantCulture, out var d))
        {
            return d;
        }
        return null;
    }
}
