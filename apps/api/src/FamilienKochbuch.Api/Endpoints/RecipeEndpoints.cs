using System.Security.Claims;
using FamilienKochbuch.Api.Http;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// S3 recipe endpoints. Every route requires authentication; authorization
/// is per-operation (must be a member of the owning group). Error payload
/// shape matches the rest of the API:
/// <c>{ "code": "...", "message": "..." }</c>.
/// </summary>
public static class RecipeEndpoints
{
    public const int DefaultPageSize = 20;
    public const int MaxPageSize = 100;
    public const long MaxPhotoBytes = 5 * 1024 * 1024;

    /// <summary>
    /// REIMPORT-0 — sentinel value the Python pipeline writes into
    /// <c>recipe.source_url</c> for the photo-import path (photos don't
    /// have a human-meaningful URL, but the ExtractedRecipe contract
    /// requires a non-null value). Mirrored here so the reimport
    /// endpoint can refuse to re-run extraction against photos (there
    /// IS no URL to re-fetch). The frontend carries the same constant
    /// in <c>apps/web/src/features/imports/importPrefill.ts</c>
    /// (<c>PHOTO_SOURCE_SENTINEL</c>) and the Python source of truth
    /// lives at <c>apps/python-extractor/src/extractor/pipeline/photo.py</c>.
    /// </summary>
    public const string PhotoSourceSentinel = "photos://upload";

    private static readonly HashSet<string> AllowedPhotoContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
    };

    // ── DTO records ─────────────────────────────────────────────────

    public record IngredientRequest(
        int Position,
        decimal? Quantity,
        string Unit,
        string Name,
        string? Note,
        bool Scalable);

    public record StepRequest(int Position, string Content);

    /// <summary>
    /// Per-portion nutrition estimate (P2-10). Mirrors the
    /// <see cref="Domain.Entities.NutritionEstimate"/> shape so the
    /// endpoint can hand the four fields straight to the domain record.
    /// All four fields are integer kcal / macro-grams.
    /// </summary>
    public record NutritionEstimateRequest(
        int Kcal,
        int ProteinG,
        int CarbsG,
        int FatG);

    public record CreateRecipeRequest(
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        IngredientRequest[] Ingredients,
        StepRequest[] Steps,
        Guid[] TagIds,
        // P2-10: optional per-portion nutrition estimate. ``null`` when
        // the caller can't supply one (manual recipe, legacy client).
        NutritionEstimateRequest? NutritionEstimate = null,
        // Optional StagedPhoto.Id values the server adopts onto the
        // new recipe (ownership-checked, blobs copied into the recipe
        // namespace). Per-photo failures surface via
        // ``partialPhotoFailures`` instead of failing the request.
        Guid[]? StagedPhotoIds = null);

    public record UpdateRecipeRequest(
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        IngredientRequest[] Ingredients,
        StepRequest[] Steps,
        Guid[] TagIds);

    public record NutritionEstimateDto(
        int Kcal,
        int ProteinG,
        int CarbsG,
        int FatG);

    public record IngredientDto(
        Guid Id,
        int Position,
        decimal? Quantity,
        string Unit,
        string Name,
        string? Note,
        bool Scalable);

    public record StepDto(Guid Id, int Position, string Content);

    public record TagDto(
        Guid Id,
        string Name,
        string Category,
        bool IsGlobal,
        Guid? GroupId,
        Guid? CreatedByUserId);

    public record RecipeSummaryDto(
        Guid Id,
        Guid GroupId,
        string Title,
        string? Description,
        string? Photo,
        Guid[] TagIds,
        string CreatedByDisplayName,
        DateTimeOffset UpdatedAt,
        double? AvgRating,
        int RatingCount,
        int? MyStars);

    public record CreateTagRequest(string Name, string Category);

    /// <summary>
    /// PAGE-0 — paginated wrapper for a recipe list page. Shape matches
    /// <c>docs/plans/2026-04-21-recipe-list-pagination-design.md</c>:
    /// <c>items</c> + the caller's echoed <c>page</c> / <c>pageSize</c>,
    /// an honest <c>total</c> (count before pagination), and the two
    /// nav flags the frontend uses to render the pagination bar without
    /// an extra round-trip.
    /// </summary>
    public record RecipeSummaryListDto(
        RecipeSummaryDto[] Items,
        int Page,
        int PageSize,
        int Total,
        bool HasNextPage,
        bool HasPrevPage);

    /// <summary>
    /// PAGE-0 — sort keys accepted by
    /// <c>GET /api/groups/{groupId}/recipes</c>. Names mirror the
    /// snake_case wire values (<see cref="TryParseRecipeSort"/>).
    /// <c>cook_count_desc</c> is intentionally absent: the domain has no
    /// <c>TimesCooked</c> / <c>CookCount</c> column or <c>CookHistory</c>
    /// table, so we can't compose that sort without either new schema
    /// or a subquery on a non-existent aggregation table. Deferred to a
    /// follow-up slice; see the design doc's "Open questions".
    /// </summary>
    public enum RecipeSortOrder
    {
        UpdatedDesc,
        CookedDesc,
        TitleAsc,
        RatingDesc,
    }

    /// <summary>
    /// Parses the snake_case <c>?sort=</c> query value into
    /// <see cref="RecipeSortOrder"/>. Returns <c>false</c> for every
    /// value not explicitly listed — unknown sorts must surface as a
    /// 400 at the endpoint layer rather than silently falling back.
    /// </summary>
    internal static bool TryParseRecipeSort(string? raw, out RecipeSortOrder sort)
    {
        switch (raw)
        {
            case null:
            case "":
            case "updated_desc":
                sort = RecipeSortOrder.UpdatedDesc;
                return true;
            case "cooked_desc":
                sort = RecipeSortOrder.CookedDesc;
                return true;
            case "title_asc":
                sort = RecipeSortOrder.TitleAsc;
                return true;
            case "rating_desc":
                sort = RecipeSortOrder.RatingDesc;
                return true;
            default:
                sort = default;
                return false;
        }
    }

    /// <summary>
    /// SEARCH-0 — result-item shape for the cross-group search endpoint.
    /// Same fields as <see cref="RecipeSummaryDto"/> plus <c>GroupName</c>
    /// so the frontend can render a group-chip per card without a
    /// follow-up groups lookup. <c>GroupId</c> is already on the summary.
    /// </summary>
    public record RecipeGlobalSearchItemDto(
        Guid Id,
        Guid GroupId,
        string GroupName,
        string Title,
        string? Description,
        string? Photo,
        Guid[] TagIds,
        string CreatedByDisplayName,
        DateTimeOffset UpdatedAt,
        double? AvgRating,
        int RatingCount,
        int? MyStars);

    /// <summary>
    /// SEARCH-0 — wrapper for <c>GET /api/recipes/search</c>. Mirrors
    /// <see cref="RecipeSummaryListDto"/> exactly (page / pageSize /
    /// total / hasNextPage / hasPrevPage) and additionally echoes the
    /// trimmed <c>query</c> so the frontend can re-synchronise its
    /// debounced URL state without re-reading <c>?q=</c>.
    /// </summary>
    public record RecipeGlobalSearchListDto(
        RecipeGlobalSearchItemDto[] Items,
        int Page,
        int PageSize,
        int Total,
        bool HasNextPage,
        bool HasPrevPage,
        string Query);

    /// <summary>
    /// SEARCH-0 — sort keys accepted by <c>GET /api/recipes/search</c>.
    /// Superset of <see cref="RecipeSortOrder"/>: adds
    /// <c>RelevanceDesc</c> (the default when <c>q</c> is set). Every
    /// other key maps 1:1 to the list-endpoint semantics so sort UI
    /// components can share a single enum on the frontend.
    /// </summary>
    public enum RecipeSearchSortOrder
    {
        RelevanceDesc,
        UpdatedDesc,
        CookedDesc,
        TitleAsc,
        RatingDesc,
    }

    /// <summary>
    /// Parses the snake_case <c>?sort=</c> query value into
    /// <see cref="RecipeSearchSortOrder"/>. Returns <c>false</c> for
    /// unknown values so the endpoint can return a 400 invalid_sort.
    /// Null / empty defaults to <c>RelevanceDesc</c>.
    /// </summary>
    internal static bool TryParseRecipeSearchSort(string? raw, out RecipeSearchSortOrder sort)
    {
        switch (raw)
        {
            case null:
            case "":
            case "relevance_desc":
                sort = RecipeSearchSortOrder.RelevanceDesc;
                return true;
            case "updated_desc":
                sort = RecipeSearchSortOrder.UpdatedDesc;
                return true;
            case "cooked_desc":
                sort = RecipeSearchSortOrder.CookedDesc;
                return true;
            case "title_asc":
                sort = RecipeSearchSortOrder.TitleAsc;
                return true;
            case "rating_desc":
                sort = RecipeSearchSortOrder.RatingDesc;
                return true;
            default:
                sort = default;
                return false;
        }
    }

    /// <summary>SEARCH-0: maximum accepted length of <c>?q=</c>. DoS
    /// guard — a 10kB query-string with a 9kB ILIKE pattern would hurt
    /// Postgres a lot more than it would hurt the caller.</summary>
    public const int SearchQueryMaxLength = 200;

    public record RecipeDetailDto(
        Guid Id,
        Guid GroupId,
        Guid CreatedByUserId,
        string CreatedByDisplayName,
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        string SourceType,
        Guid? ForkOfRecipeId,
        string[] Photos,
        DateTimeOffset? LastCookedAt,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        // OFF3: optimistic-concurrency counter the client mirrors into
        // the If-Match header on subsequent PUT/PATCH/DELETE. Starts at
        // 0 on a freshly created recipe; bumps once per mutation.
        int Version,
        IngredientDto[] Ingredients,
        StepDto[] Steps,
        TagDto[] Tags,
        // P2-10: nullable per-portion nutrition estimate — always
        // present on the response (null when unset) so the frontend
        // never has to probe for a missing key.
        NutritionEstimateDto? NutritionEstimate,
        // Per-photo failures from the create-recipe promote flow.
        // Always ``null`` outside the create response — read paths
        // (Get/Update/Fork/PatchNutrition/MarkCooked) leave this off
        // so their contract is unchanged.
        PartialPhotoFailureDto[]? PartialPhotoFailures = null);

    /// <summary>
    /// Surfaces the reason a single staged-photo promote failed during
    /// create-recipe. The ``Reason`` is a short German message the
    /// frontend banner displays verbatim.
    /// </summary>
    public record PartialPhotoFailureDto(Guid StagedPhotoId, string Reason);

    public record UploadPhotoResponse(string Url);

    public record RemovePhotoRequest(string Url);

    public record ForkRecipeRequest(Guid TargetGroupId);

    /// <summary>
    /// Response for <c>POST /api/recipes/photos/staged</c>. <see cref="StagedPhotoId"/>
    /// is the currency for the create-recipe promote handshake; <see cref="PhotoId"/>
    /// (the bare SeaweedFS path) is retained for the legacy import-photos flow.
    /// </summary>
    public record StagedPhotoResponse(string PhotoId, string SignedUrl, Guid StagedPhotoId);

    // ── Endpoint wiring ─────────────────────────────────────────────

    public static void MapRecipeEndpoints(this WebApplication app)
    {
        var groupRecipes = app.MapGroup("/api/groups/{groupId:guid}/recipes")
            .WithTags("Recipes")
            .RequireAuthorization();
        groupRecipes.MapPost("/", CreateRecipeAsync).DisableAntiforgery();
        groupRecipes.MapGet("/", ListGroupRecipesAsync);

        var groupTags = app.MapGroup("/api/groups/{groupId:guid}/tags")
            .WithTags("Tags")
            .RequireAuthorization();
        groupTags.MapGet("/", ListGroupTagsAsync);
        groupTags.MapPost("/", CreateGroupTagAsync);
        groupTags.MapDelete("/{tagId:guid}", DeleteGroupTagAsync);

        var recipe = app.MapGroup("/api/recipes/{id:guid}")
            .WithTags("Recipes")
            .RequireAuthorization();
        recipe.MapGet("/", GetRecipeAsync);
        recipe.MapPut("/", UpdateRecipeAsync);
        recipe.MapDelete("/", DeleteRecipeAsync);
        // ExcludeFromDescription: Swashbuckle 9.0.6 can't generate schemas
        // for Minimal API endpoints that take [FromForm] IFormFile; the
        // route still works, it just doesn't appear in the Swagger UI.
        recipe.MapPost("/photos", UploadPhotoAsync).DisableAntiforgery().ExcludeFromDescription();
        recipe.MapDelete("/photos", RemovePhotoAsync);
        recipe.MapPost("/fork", ForkRecipeAsync);
        recipe.MapPost("/cook", MarkCookedAsync);
        // P2-10: PATCH for the estimated per-portion nutrition. Author
        // or admin only; a null body clears the estimate.
        recipe.MapPatch("/nutrition", PatchNutritionAsync);

        // REIMPORT-0: re-run the URL extractor against the recipe's
        // stored `SourceUrl` and overwrite the current body in place.
        // Empty body — the URL always comes from the DB so a client can
        // never redirect the job at an arbitrary host (SSRF guard).
        recipe.MapPost("/reimport", ReimportRecipeAsync);

        // P2-8: staged photo upload for the import-from-photos flow.
        // Lives outside the {id:guid} group because the photo isn't yet
        // bound to a recipe — the user is uploading images to feed into
        // the AI extraction pipeline. Returns a signed URL valid for the
        // same window as any other photo URL (2 h default; 1 h per-plan
        // override below). The URL is consumed by
        // POST /api/recipes/import/photos whose signed-URL verifier
        // accepts any path under the shared /api/photos/ prefix.
        app.MapPost("/api/recipes/photos/staged", UploadStagedPhotoAsync)
            .WithTags("Recipes")
            .RequireAuthorization()
            .DisableAntiforgery()
            .ExcludeFromDescription();

        // BUG-024 — let the review form drop an import-uploaded photo
        // the user decided to discard before saving. Complements the
        // hourly SweepAbandonedStagedPhotosJob: this is the
        // user-initiated path, the sweep is the timeout fallback.
        app.MapDelete("/api/staged-photos/{id:guid}", DeleteStagedPhotoAsync)
            .WithTags("Recipes")
            .RequireAuthorization();

        // SEARCH-0 — top-level cross-group recipe search. Lives outside
        // the /api/groups/{id} prefix because authz scopes by the
        // caller's membership set rather than a single group id.
        app.MapGet("/api/recipes/search", SearchRecipesGloballyAsync)
            .WithTags("Recipes")
            .RequireAuthorization();
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }

    private static Task<bool> IsGroupMemberAsync(AppDbContext db, Guid groupId, Guid userId, CancellationToken ct) =>
        db.GroupMemberships.AnyAsync(m => m.GroupId == groupId && m.UserId == userId, ct);

    private static async Task<Recipe?> LoadRecipeWithChildrenAsync(AppDbContext db, Guid id, CancellationToken ct) =>
        await db.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);

    private static async Task<RecipeDetailDto> ProjectDetailAsync(
        AppDbContext db,
        Recipe recipe,
        IPhotoStorage photoStorage,
        CancellationToken ct,
        PartialPhotoFailureDto[]? partialPhotoFailures = null)
    {
        var creator = await db.Users
            .Where(u => u.Id == recipe.CreatedByUserId)
            .Select(u => u.DisplayName)
            .SingleAsync(ct);

        var tagIds = recipe.RecipeTags.Select(rt => rt.TagId).ToArray();
        var tagsRaw = await db.Tags
            .Where(t => tagIds.Contains(t.Id))
            .Select(t => new TagDto(
                t.Id, t.Name, t.Category.ToString(),
                t.CreatedByUserId == null && t.GroupId == null,
                t.GroupId, t.CreatedByUserId))
            .ToArrayAsync(ct);

        var tags = tagsRaw
            .OrderBy(t => t.Category, StringComparer.Ordinal)
            .ThenBy(t => t.Name, StringComparer.CurrentCulture)
            .ToArray();

        var ingredients = recipe.Ingredients
            .OrderBy(i => i.Position)
            .Select(i => new IngredientDto(i.Id, i.Position, i.Quantity, i.Unit, i.Name, i.Note, i.Scalable))
            .ToArray();

        var steps = recipe.Steps
            .OrderBy(s => s.Position)
            .Select(s => new StepDto(s.Id, s.Position, s.Content))
            .ToArray();

        // Photos are stored as bare paths in the DB; project them through
        // IPhotoStorage.GetPublicUrl so every response carries a freshly
        // signed, time-bounded proxy URL.
        var photos = recipe.Photos
            .Select(photoStorage.GetPublicUrl)
            .ToArray();

        var nutritionDto = recipe.NutritionEstimate is null
            ? null
            : new NutritionEstimateDto(
                recipe.NutritionEstimate.Kcal,
                recipe.NutritionEstimate.ProteinG,
                recipe.NutritionEstimate.CarbsG,
                recipe.NutritionEstimate.FatG);

        return new RecipeDetailDto(
            recipe.Id,
            recipe.GroupId,
            recipe.CreatedByUserId,
            creator,
            recipe.Title,
            recipe.Description,
            recipe.DefaultServings,
            recipe.PrepTimeMinutes,
            recipe.Difficulty,
            recipe.SourceUrl,
            recipe.SourceType.ToString(),
            recipe.ForkOfRecipeId,
            photos,
            recipe.LastCookedAt,
            recipe.CreatedAt,
            recipe.UpdatedAt,
            recipe.Version,
            ingredients,
            steps,
            tags,
            nutritionDto,
            partialPhotoFailures);
    }

    // ── POST /api/groups/{groupId}/recipes ──────────────────────────

    private static async Task<IResult> CreateRecipeAsync(
        Guid groupId,
        CreateRecipeRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        IRecipeRevisionService revisionService,
        TimeProvider clock,
        ILogger<PromoteStagedPhotosLogCategory> promoteLogger,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        // Validate tag ids — must be global or scoped to this group.
        if (!await AreTagIdsValidForGroupAsync(db, body.TagIds, groupId, ct))
            return FamilienResults.BadRequest("invalid_tag", "Ein oder mehrere Tags sind unbekannt oder gehören nicht zur Gruppe.");

        Recipe recipe;
        try
        {
            var now = clock.GetUtcNow();
            recipe = new Recipe(
                groupId: groupId,
                createdByUserId: userId,
                title: body.Title,
                description: body.Description,
                defaultServings: body.DefaultServings,
                prepTimeMinutes: body.PrepTimeMinutes,
                difficulty: body.Difficulty,
                sourceUrl: body.SourceUrl,
                sourceType: RecipeSourceType.Manual,
                forkOfRecipeId: null,
                createdAt: now);

            foreach (var ing in body.Ingredients.OrderBy(i => i.Position))
            {
                recipe.Ingredients.Add(new Ingredient(
                    recipeId: recipe.Id,
                    position: ing.Position,
                    quantity: ing.Quantity,
                    unit: ing.Unit,
                    name: ing.Name,
                    note: ing.Note,
                    scalable: ing.Scalable));
            }

            foreach (var step in body.Steps.OrderBy(s => s.Position))
            {
                recipe.Steps.Add(new RecipeStep(recipe.Id, step.Position, step.Content));
            }

            foreach (var tagId in body.TagIds.Distinct())
            {
                recipe.RecipeTags.Add(new RecipeTag(recipe.Id, tagId));
            }

            // P2-10: persist the optional nutrition estimate. The domain
            // record validates the four bounds so out-of-range numbers
            // from a drifting AI import bubble out as an invalid_input
            // 400 — matching the rest of the endpoint's error taxonomy.
            if (body.NutritionEstimate is { } n)
            {
                recipe.SetNutritionEstimate(
                    new Domain.Entities.NutritionEstimate(n.Kcal, n.ProteinG, n.CarbsG, n.FatG),
                    now);
            }

            db.Recipes.Add(recipe);
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        // S6: record the initial Created revision so the history panel
        // shows authorship from day one.
        await revisionService.RecordAsync(
            recipe.Id, userId, RecipeChangeType.Created, clock.GetUtcNow(), ct);

        // Sequential + best-effort: a single failed photo doesn't
        // take down the others, and the saved recipe is kept even if
        // every promote fails (the user can re-upload from the detail
        // page).
        var partialFailures = await PromoteStagedPhotosAsync(
            db, photoStorage, clock, promoteLogger,
            recipe, userId, body.StagedPhotoIds, ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct,
            partialPhotoFailures: partialFailures.Count == 0 ? null : partialFailures.ToArray());
        return Results.Created($"/api/recipes/{recipe.Id}", detail);
    }

    /// <summary>German error strings surfaced per-photo by
    /// <see cref="PromoteStagedPhotosAsync"/>. The frontend banner
    /// displays these verbatim.</summary>
    private static class PromoteErrors
    {
        public const string NotFound = "Foto wurde nicht gefunden.";
        public const string NotOwner = "Foto gehört nicht dir.";
        public const string AlreadyPromoted = "Foto wurde bereits einem Rezept zugeordnet.";
        public const string CopyFailed = "Foto konnte nicht kopiert werden.";
        public const string SaveFailed = "Foto konnte nicht gespeichert werden.";

        public static string LimitReached(int max) =>
            $"Maximal {max} Fotos pro Rezept – Limit erreicht.";
    }

    /// <summary>
    /// Adopts staged photos onto the freshly-saved recipe.
    ///
    /// Per-photo the blob copy + <see cref="Recipe.AddPhoto"/> +
    /// <c>StagedPhoto.MarkPromoted</c> share one <c>SaveChangesAsync</c>
    /// so an EF failure rolls both back; the source-blob delete is
    /// best-effort (the hourly sweep job reaps orphans).
    ///
    /// Any per-photo error is captured into the returned partial-failure
    /// list — the recipe stays alive even if every photo fails.
    /// Ownership-mismatched ids drop into the failure list rather than
    /// 400: the id is a frontend bug, not an attack surface, since the
    /// photo's bytes never land on the recipe.
    /// </summary>
    private static async Task<List<PartialPhotoFailureDto>> PromoteStagedPhotosAsync(
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        ILogger logger,
        Recipe recipe,
        Guid userId,
        Guid[]? stagedPhotoIds,
        CancellationToken ct)
    {
        var failures = new List<PartialPhotoFailureDto>();
        var sourceBlobsToDelete = new List<string>();
        if (stagedPhotoIds is null || stagedPhotoIds.Length == 0)
            return failures;

        // Stable order = caller-provided order; de-dup so the same id
        // doesn't get processed twice.
        var distinctIds = stagedPhotoIds.Distinct().ToArray();
        var rows = await db.StagedPhotos
            .Where(s => distinctIds.Contains(s.Id))
            .ToDictionaryAsync(s => s.Id, ct);

        foreach (var stagedId in distinctIds)
        {
            // Photo cap: stop attaching once the recipe is full. Surface
            // the remaining ids as partial failures so the user knows
            // why their later photos didn't land.
            if (recipe.Photos.Count >= Recipe.MaxPhotos)
            {
                failures.Add(new PartialPhotoFailureDto(
                    stagedId, PromoteErrors.LimitReached(Recipe.MaxPhotos)));
                continue;
            }

            if (!rows.TryGetValue(stagedId, out var staged))
            {
                failures.Add(new PartialPhotoFailureDto(stagedId, PromoteErrors.NotFound));
                continue;
            }

            if (staged.UserId != userId)
            {
                logger.LogWarning(
                    "User {UserId} tried to promote staged photo {StagedPhotoId} owned by {OwnerId} — silently filtered out.",
                    userId, staged.Id, staged.UserId);
                failures.Add(new PartialPhotoFailureDto(stagedId, PromoteErrors.NotOwner));
                continue;
            }

            if (staged.PromotedAt is not null)
            {
                failures.Add(new PartialPhotoFailureDto(stagedId, PromoteErrors.AlreadyPromoted));
                continue;
            }

            string destinationPath;
            try
            {
                // Copy first so a download/upload failure is surfaced
                // BEFORE we touch the recipe + staged-photo state. The
                // storage layer owns path generation.
                destinationPath = await photoStorage.CopyAsync(
                    staged.PhotoId, staged.ContentType, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Failed to copy staged photo {StagedPhotoId} ({SourcePath}) for recipe {RecipeId}.",
                    staged.Id, staged.PhotoId, recipe.Id);
                failures.Add(new PartialPhotoFailureDto(stagedId, PromoteErrors.CopyFailed));
                continue;
            }

            try
            {
                // Atomic per-photo: photo-attach + StagedPhoto state
                // change in one SaveChanges.
                recipe.AddPhoto(destinationPath);
                staged.MarkPromoted(recipe.Id, clock.GetUtcNow());
                await db.SaveChangesAsync(ct);
            }
            catch (Exception ex)
            {
                logger.LogError(ex,
                    "Promote DB write failed for staged photo {StagedPhotoId} -> recipe {RecipeId}.",
                    staged.Id, recipe.Id);
                // Roll back the in-memory recipe.AddPhoto so the next
                // iteration's MaxPhotos check is honest, and best-effort
                // delete the just-copied destination blob so it doesn't
                // linger orphaned.
                recipe.RemovePhoto(destinationPath);
                try
                {
                    await photoStorage.DeleteAsync(destinationPath, ct);
                }
                catch (Exception cleanupEx)
                {
                    logger.LogWarning(cleanupEx,
                        "Cleanup of orphaned destination blob {DestinationPath} failed; sweep job will retry.",
                        destinationPath);
                }
                failures.Add(new PartialPhotoFailureDto(stagedId, PromoteErrors.SaveFailed));
                continue;
            }

            // Queue the staged-source-blob deletion for post-response
            // cleanup — it's not on the critical path (the sweep job
            // reaps orphans anyway) so we don't make the user wait
            // for N sequential filer DELETEs. See FireAndForget call
            // after the loop.
            sourceBlobsToDelete.Add(staged.PhotoId);
        }

        FireAndForgetDeleteStagedBlobs(photoStorage, sourceBlobsToDelete, logger);

        return failures;
    }

    /// <summary>
    /// Deletes staged source blobs in the background after a successful
    /// promote cycle. The caller has already returned by the time this
    /// runs, so a slow filer doesn't block the user's response. Any
    /// leftover blobs are reaped by SweepAbandonedStagedPhotosJob on
    /// the next hourly pass, so failures here are non-critical.
    /// </summary>
    private static void FireAndForgetDeleteStagedBlobs(
        IPhotoStorage photoStorage,
        IReadOnlyList<string> sourcePaths,
        ILogger logger)
    {
        if (sourcePaths.Count == 0) return;
        _ = Task.Run(async () =>
        {
            foreach (var sourcePath in sourcePaths)
            {
                try
                {
                    await photoStorage.DeleteAsync(sourcePath, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex,
                        "Background cleanup of staged source blob {StagedPath} failed — sweep job will retry.",
                        sourcePath);
                }
            }
        });
    }

    private static async Task<bool> AreTagIdsValidForGroupAsync(
        AppDbContext db, IReadOnlyCollection<Guid> tagIds, Guid groupId, CancellationToken ct)
    {
        if (tagIds.Count == 0) return true;
        var distinct = tagIds.Distinct().ToArray();
        var validCount = await db.Tags
            .CountAsync(t => distinct.Contains(t.Id) && (t.GroupId == null || t.GroupId == groupId), ct);
        return validCount == distinct.Length;
    }

    // ── GET /api/groups/{groupId}/recipes ───────────────────────────

    /// <summary>
    /// PAGE-0 — paginated recipe list for a group. Contract mirrors
    /// <c>docs/plans/2026-04-21-recipe-list-pagination-design.md</c>:
    /// <c>page</c> ≥ 1 (default 1), <c>pageSize</c> 1–100 (default 24),
    /// <c>sort</c> one of the <see cref="RecipeSortOrder"/> snake_case
    /// values (default <c>updated_desc</c>). Every sort carries
    /// <c>Id ASC</c> as a stable tie-breaker. Deep-links past the last
    /// page return an empty items array + honest <c>total</c> (no 404).
    /// </summary>
    private static async Task<IResult> ListGroupRecipesAsync(
        Guid groupId,
        int? page,
        int? pageSize,
        string? sort,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        // Validate query params BEFORE touching the DB. Each has its
        // own stable error code the frontend keys off.
        var effectivePage = page ?? 1;
        if (effectivePage < 1)
        {
            return FamilienResults.BadRequest("invalid_page",
                $"Die Seitenzahl muss mindestens 1 sein (erhalten: {effectivePage}).");
        }

        var effectivePageSize = pageSize ?? ListDefaultPageSize;
        if (effectivePageSize < 1 || effectivePageSize > MaxPageSize)
        {
            return FamilienResults.BadRequest("invalid_page_size",
                $"Die Seitengröße muss zwischen 1 und {MaxPageSize} liegen (erhalten: {effectivePageSize}).");
        }

        if (!TryParseRecipeSort(sort, out var sortOrder))
        {
            return FamilienResults.BadRequest("invalid_sort",
                $"Unbekannte Sortierung '{sort}'. Erlaubt: updated_desc, cooked_desc, title_asc, rating_desc.");
        }

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var baseQuery = db.Recipes.Where(r => r.GroupId == groupId && r.DeletedAt == null);
        var total = await baseQuery.CountAsync(ct);

        // SQLite can't ORDER BY DateTimeOffset server-side (Postgres can),
        // so we materialize the group slice and sort / page in memory.
        // Group-level sizes (≤ 500 recipes typical) keep this sub-ms.
        // When Postgres replaces SQLite for production queries, the
        // partial composite indexes added by the AddRecipesListPagination
        // migration match each sort's (Group, key, Id) ordering.
        var projected = await baseQuery
            .Select(r => new RecipeListRow
            {
                Recipe = r,
                CreatorDisplay = db.Users.Where(u => u.Id == r.CreatedByUserId)
                    .Select(u => u.DisplayName).FirstOrDefault() ?? string.Empty,
                // Average returns 0.0 over an empty sequence in SQL; we
                // short-circuit to ``null`` via RatingCount below so the
                // DTO reflects "unrated" instead of "0.0 stars".
                AvgRating = db.Ratings.Where(rt => rt.RecipeId == r.Id)
                    .Select(rt => (double?)rt.Stars).Average(),
                RatingCount = db.Ratings.Count(rt => rt.RecipeId == r.Id),
                MyStars = db.Ratings
                    .Where(rt => rt.RecipeId == r.Id && rt.UserId == userId)
                    .Select(rt => (int?)rt.Stars)
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        // Guard against Skip() overflow on pathological `page` values
        // (e.g. ``page=int.MaxValue&pageSize=100``). A negative Skip
        // would silently return the whole collection. Short-circuit
        // once the offset exceeds the materialised row count.
        var offsetLong = (long)(effectivePage - 1) * effectivePageSize;
        var rows = offsetLong >= projected.Count
            ? new List<RecipeListRow>()
            : ApplyListSort(projected, sortOrder)
                .Skip((int)offsetLong)
                .Take(effectivePageSize)
                .ToList();

        var recipeIds = rows.Select(x => x.Recipe.Id).ToArray();
        var tagMap = await db.RecipeTags
            .Where(rt => recipeIds.Contains(rt.RecipeId))
            .Select(rt => new { rt.RecipeId, rt.TagId })
            .ToListAsync(ct);
        var tagsByRecipe = tagMap
            .GroupBy(x => x.RecipeId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.TagId).ToArray());

        var items = rows.Select(row =>
        {
            var firstPhotoPath = row.Recipe.Photos.FirstOrDefault();
            var firstPhotoUrl = string.IsNullOrEmpty(firstPhotoPath)
                ? null
                : photoStorage.GetPublicUrl(firstPhotoPath);

            double? avg = row.RatingCount == 0 || row.AvgRating is null
                ? null
                : Math.Round(row.AvgRating.Value, 1);

            return new RecipeSummaryDto(
                row.Recipe.Id,
                row.Recipe.GroupId,
                row.Recipe.Title,
                row.Recipe.Description,
                firstPhotoUrl,
                tagsByRecipe.TryGetValue(row.Recipe.Id, out var ids) ? ids : Array.Empty<Guid>(),
                row.CreatorDisplay,
                row.Recipe.UpdatedAt,
                avg,
                row.RatingCount,
                row.MyStars);
        }).ToArray();

        // ``(long)`` guard matches the overflow-safe offset computation
        // above so an attacker-chosen huge ``page`` can't flip the
        // comparison back below zero.
        var hasNextPage = (long)effectivePage * effectivePageSize < total;
        var hasPrevPage = effectivePage > 1;

        return Results.Ok(new RecipeSummaryListDto(
            items, effectivePage, effectivePageSize, total, hasNextPage, hasPrevPage));
    }

    /// <summary>PAGE-0 default page size (grid-friendly 6×4 on desktop,
    /// 2×12 on mobile). Separate from <see cref="DefaultPageSize"/> so
    /// other callers that rely on the legacy 20 default keep their
    /// behaviour.</summary>
    public const int ListDefaultPageSize = 24;

    private sealed class RecipeListRow
    {
        public Domain.Entities.Recipe Recipe { get; set; } = null!;
        public string CreatorDisplay { get; set; } = string.Empty;
        public double? AvgRating { get; set; }
        public int RatingCount { get; set; }
        public int? MyStars { get; set; }
    }

    /// <summary>
    /// Applies the PAGE-0 sort plus the mandatory <c>Id ASC</c> tie-breaker.
    /// NULL handling for <c>LastCookedAt</c> / <c>AvgRating</c> maps nulls
    /// to the "bottom" of the DESC order so unrated / never-cooked recipes
    /// appear last, matching the Postgres <c>NULLS LAST</c> behaviour the
    /// partial indexes target.
    /// </summary>
    private static IOrderedEnumerable<RecipeListRow> ApplyListSort(
        IEnumerable<RecipeListRow> rows, RecipeSortOrder sort) => sort switch
    {
        RecipeSortOrder.CookedDesc => rows
            .OrderByDescending(x => x.Recipe.LastCookedAt ?? DateTimeOffset.MinValue)
            .ThenBy(x => x.Recipe.Id),
        RecipeSortOrder.TitleAsc => rows
            .OrderBy(x => x.Recipe.Title, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(x => x.Recipe.Id),
        RecipeSortOrder.RatingDesc => rows
            .OrderByDescending(x => x.RatingCount == 0 ? double.MinValue : x.AvgRating ?? double.MinValue)
            .ThenBy(x => x.Recipe.Id),
        _ => rows
            .OrderByDescending(x => x.Recipe.UpdatedAt)
            .ThenBy(x => x.Recipe.Id),
    };

    // ── GET /api/recipes/search ─────────────────────────────────────

    /// <summary>
    /// SEARCH-0 — cross-group recipe search. Authz scopes to the caller's
    /// group-membership set; `q` is ILIKE-matched against Title /
    /// Description / Tag names. When <c>sort=relevance_desc</c> (the
    /// default when <c>q</c> is set) the result is ordered by a
    /// title(3) + tag(2) + description(1) score. Every other sort key
    /// mirrors the list endpoint's semantics exactly.
    /// </summary>
    private static async Task<IResult> SearchRecipesGloballyAsync(
        string? q,
        int? page,
        int? pageSize,
        string? sort,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        // Trim + validate `q`. Empty / whitespace-only / over-length all
        // collapse to the same `invalid_query` code so the frontend has
        // one error bucket for "bad search term".
        var trimmedQ = q?.Trim() ?? string.Empty;
        if (trimmedQ.Length < 1 || trimmedQ.Length > SearchQueryMaxLength)
        {
            return FamilienResults.BadRequest("invalid_query",
                $"Der Suchbegriff muss zwischen 1 und {SearchQueryMaxLength} Zeichen lang sein.");
        }

        var effectivePage = page ?? 1;
        if (effectivePage < 1)
        {
            return FamilienResults.BadRequest("invalid_page",
                $"Die Seitenzahl muss mindestens 1 sein (erhalten: {effectivePage}).");
        }

        var effectivePageSize = pageSize ?? ListDefaultPageSize;
        if (effectivePageSize < 1 || effectivePageSize > MaxPageSize)
        {
            return FamilienResults.BadRequest("invalid_page_size",
                $"Die Seitengröße muss zwischen 1 und {MaxPageSize} liegen (erhalten: {effectivePageSize}).");
        }

        if (!TryParseRecipeSearchSort(sort, out var sortOrder))
        {
            return FamilienResults.BadRequest("invalid_sort",
                $"Unbekannte Sortierung '{sort}'. Erlaubt: relevance_desc, updated_desc, cooked_desc, title_asc, rating_desc.");
        }

        // Authz — the single boundary. A recipe survives this filter
        // only when its group appears in the caller's membership set.
        var memberGroupIds = db.GroupMemberships
            .Where(gm => gm.UserId == userId)
            .Select(gm => gm.GroupId);

        // ILIKE-equivalent via EF.Functions.Like over a ToUpper()'d
        // pattern — portable across Postgres (production) and SQLite
        // (integration tests), whose LIKE is case-sensitive by default.
        // Postgres's own `ILIKE` could be used via EF.Functions.ILike,
        // but SQLite wouldn't translate it.
        var upperPattern = $"%{trimmedQ.ToUpperInvariant()}%";

        // Single filtering query — EF composes the recipe + group join
        // alongside the three text-match predicates into a single SQL
        // statement. The tag match lives in a correlated EXISTS so we
        // don't pull RecipeTags / Tags rows into memory.
        var baseQuery = db.Recipes
            .Where(r => r.DeletedAt == null)
            .Where(r => memberGroupIds.Contains(r.GroupId))
            .Where(r =>
                EF.Functions.Like(r.Title.ToUpper(), upperPattern)
                || (r.Description != null && EF.Functions.Like(r.Description.ToUpper(), upperPattern))
                || db.RecipeTags
                    .Where(rt => rt.RecipeId == r.Id)
                    .Join(db.Tags, rt => rt.TagId, t => t.Id, (rt, t) => t.Name)
                    .Any(name => EF.Functions.Like(name.ToUpper(), upperPattern)));

        var total = await baseQuery.CountAsync(ct);

        // Pull the filtered rows + pre-computed match flags for scoring,
        // aggregates for the summary DTO, and the owning group's name.
        // SQLite can't ORDER BY DateTimeOffset server-side, so for
        // parity with the PAGE-0 list endpoint we materialise once and
        // sort / paginate in memory. Group-count ×
        // max-matches-per-group stays small at family scale.
        var projected = await baseQuery
            .Select(r => new RecipeSearchRow
            {
                Recipe = r,
                GroupName = db.Groups.Where(g => g.Id == r.GroupId)
                    .Select(g => g.Name).FirstOrDefault() ?? string.Empty,
                CreatorDisplay = db.Users.Where(u => u.Id == r.CreatedByUserId)
                    .Select(u => u.DisplayName).FirstOrDefault() ?? string.Empty,
                TitleMatches = EF.Functions.Like(r.Title.ToUpper(), upperPattern),
                DescriptionMatches = r.Description != null
                    && EF.Functions.Like(r.Description.ToUpper(), upperPattern),
                TagMatches = db.RecipeTags
                    .Where(rt => rt.RecipeId == r.Id)
                    .Join(db.Tags, rt => rt.TagId, t => t.Id, (rt, t) => t.Name)
                    .Any(name => EF.Functions.Like(name.ToUpper(), upperPattern)),
                AvgRating = db.Ratings.Where(rt => rt.RecipeId == r.Id)
                    .Select(rt => (double?)rt.Stars).Average(),
                RatingCount = db.Ratings.Count(rt => rt.RecipeId == r.Id),
                MyStars = db.Ratings
                    .Where(rt => rt.RecipeId == r.Id && rt.UserId == userId)
                    .Select(rt => (int?)rt.Stars)
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        foreach (var row in projected)
        {
            row.Score = (row.TitleMatches ? 3 : 0)
                + (row.TagMatches ? 2 : 0)
                + (row.DescriptionMatches ? 1 : 0);
        }

        var offsetLong = (long)(effectivePage - 1) * effectivePageSize;
        var pageRows = offsetLong >= projected.Count
            ? new List<RecipeSearchRow>()
            : ApplySearchSort(projected, sortOrder)
                .Skip((int)offsetLong)
                .Take(effectivePageSize)
                .ToList();

        var recipeIds = pageRows.Select(x => x.Recipe.Id).ToArray();
        var tagMap = await db.RecipeTags
            .Where(rt => recipeIds.Contains(rt.RecipeId))
            .Select(rt => new { rt.RecipeId, rt.TagId })
            .ToListAsync(ct);
        var tagsByRecipe = tagMap
            .GroupBy(x => x.RecipeId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.TagId).ToArray());

        var items = pageRows.Select(row =>
        {
            var firstPhotoPath = row.Recipe.Photos.FirstOrDefault();
            var firstPhotoUrl = string.IsNullOrEmpty(firstPhotoPath)
                ? null
                : photoStorage.GetPublicUrl(firstPhotoPath);

            double? avg = row.RatingCount == 0 || row.AvgRating is null
                ? null
                : Math.Round(row.AvgRating.Value, 1);

            return new RecipeGlobalSearchItemDto(
                row.Recipe.Id,
                row.Recipe.GroupId,
                row.GroupName,
                row.Recipe.Title,
                row.Recipe.Description,
                firstPhotoUrl,
                tagsByRecipe.TryGetValue(row.Recipe.Id, out var ids) ? ids : Array.Empty<Guid>(),
                row.CreatorDisplay,
                row.Recipe.UpdatedAt,
                avg,
                row.RatingCount,
                row.MyStars);
        }).ToArray();

        var hasNextPage = (long)effectivePage * effectivePageSize < total;
        var hasPrevPage = effectivePage > 1;

        return Results.Ok(new RecipeGlobalSearchListDto(
            items, effectivePage, effectivePageSize, total,
            hasNextPage, hasPrevPage, trimmedQ));
    }

    private sealed class RecipeSearchRow
    {
        public Domain.Entities.Recipe Recipe { get; set; } = null!;
        public string GroupName { get; set; } = string.Empty;
        public string CreatorDisplay { get; set; } = string.Empty;
        public bool TitleMatches { get; set; }
        public bool DescriptionMatches { get; set; }
        public bool TagMatches { get; set; }
        public double? AvgRating { get; set; }
        public int RatingCount { get; set; }
        public int? MyStars { get; set; }
        public int Score { get; set; }
    }

    /// <summary>
    /// SEARCH-0 sort. <c>RelevanceDesc</c> orders by the precomputed
    /// <see cref="RecipeSearchRow.Score"/> DESC; every other key reuses
    /// the PAGE-0 list-sort semantics (same NULLS LAST handling) so the
    /// two endpoints are interchangeable for the non-relevance sorts.
    /// All orderings end on <c>Id ASC</c> for a deterministic
    /// tie-break.
    /// </summary>
    private static IOrderedEnumerable<RecipeSearchRow> ApplySearchSort(
        IEnumerable<RecipeSearchRow> rows, RecipeSearchSortOrder sort) => sort switch
    {
        RecipeSearchSortOrder.UpdatedDesc => rows
            .OrderByDescending(x => x.Recipe.UpdatedAt)
            .ThenBy(x => x.Recipe.Id),
        RecipeSearchSortOrder.CookedDesc => rows
            .OrderByDescending(x => x.Recipe.LastCookedAt ?? DateTimeOffset.MinValue)
            .ThenBy(x => x.Recipe.Id),
        RecipeSearchSortOrder.TitleAsc => rows
            .OrderBy(x => x.Recipe.Title, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(x => x.Recipe.Id),
        RecipeSearchSortOrder.RatingDesc => rows
            .OrderByDescending(x => x.RatingCount == 0 ? double.MinValue : x.AvgRating ?? double.MinValue)
            .ThenBy(x => x.Recipe.Id),
        _ => rows
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Recipe.Id),
    };

    // ── GET /api/recipes/{id} ───────────────────────────────────────

    private static async Task<IResult> GetRecipeAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return ETagHelper.Ok(detail, recipe.Id, recipe.Version);
    }

    // ── PUT /api/recipes/{id} ───────────────────────────────────────

    private static async Task<IResult> UpdateRecipeAsync(
        Guid id,
        UpdateRecipeRequest body,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        IRecipeRevisionService revisionService,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        // OFF3: optimistic-concurrency check. Absent If-Match is allowed
        // (backward-compat with pre-OFF3 clients); a mismatched value
        // returns 409 with the server's current detail as the `current`
        // projection so the frontend can render the conflict UI.
        var currentDtoForConflict = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        var conflict = ETagHelper.RequireMatchingVersion(
            httpRequest, recipe, () => recipe.Id, currentDtoForConflict);
        if (conflict is not null) return conflict;

        if (!await AreTagIdsValidForGroupAsync(db, body.TagIds, recipe.GroupId, ct))
            return FamilienResults.BadRequest("invalid_tag", "Ein oder mehrere Tags sind unbekannt oder gehören nicht zur Gruppe.");

        try
        {
            var now = clock.GetUtcNow();
            recipe.UpdateMetadata(
                title: body.Title,
                description: body.Description,
                defaultServings: body.DefaultServings,
                prepTimeMinutes: body.PrepTimeMinutes,
                difficulty: body.Difficulty,
                sourceUrl: body.SourceUrl,
                sourceType: recipe.SourceType,
                updatedAt: now);

            // Wholesale replace: delete existing children in one pass, save,
            // then insert the replacement set. Doing it in two SaveChanges
            // calls avoids optimistic-concurrency and unique-index conflicts
            // when positions overlap between the old and new sets.
            var existingIngredients = await db.Ingredients.Where(i => i.RecipeId == recipe.Id).ToListAsync(ct);
            db.Ingredients.RemoveRange(existingIngredients);
            var existingSteps = await db.RecipeSteps.Where(s => s.RecipeId == recipe.Id).ToListAsync(ct);
            db.RecipeSteps.RemoveRange(existingSteps);
            var existingTags = await db.RecipeTags.Where(rt => rt.RecipeId == recipe.Id).ToListAsync(ct);
            db.RecipeTags.RemoveRange(existingTags);
            await db.SaveChangesAsync(ct);

            foreach (var ing in body.Ingredients.OrderBy(i => i.Position))
            {
                db.Ingredients.Add(new Ingredient(
                    recipe.Id, ing.Position, ing.Quantity, ing.Unit, ing.Name, ing.Note, ing.Scalable));
            }
            foreach (var step in body.Steps.OrderBy(s => s.Position))
            {
                db.RecipeSteps.Add(new RecipeStep(recipe.Id, step.Position, step.Content));
            }
            foreach (var tagId in body.TagIds.Distinct())
            {
                db.RecipeTags.Add(new RecipeTag(recipe.Id, tagId));
            }
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }
        catch (DbUpdateConcurrencyException)
        {
            // OFF3: someone else wrote to this recipe between our read
            // and this save. Map to the same 409 shape as the If-Match
            // check — re-project the current state so the client sees a
            // fresh DTO + version.
            var current = (await LoadRecipeWithChildrenAsync(db, id, ct))!;
            var currentDto = await ProjectDetailAsync(db, current, photoStorage, ct);
            return FamilienResults.Conflict(
                "version_mismatch",
                "Der Eintrag wurde zwischenzeitlich geändert.",
                (object?)currentDto);
        }

        // Reload to project the detail DTO from fresh state.
        recipe = (await LoadRecipeWithChildrenAsync(db, recipe.Id, ct))!;

        // S6: record an Edited revision. The service is a no-op when the
        // resulting snapshot deep-equals the previous one, so PUTs that
        // don't actually change the body don't pollute history.
        await revisionService.RecordAsync(
            recipe.Id, userId, RecipeChangeType.Edited, clock.GetUtcNow(), ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return ETagHelper.Ok(detail, recipe.Id, recipe.Version);
    }

    // ── DELETE /api/recipes/{id} ────────────────────────────────────

    private static async Task<IResult> DeleteRecipeAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();

        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        recipe.SoftDelete(clock.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    // ── POST /api/recipes/{id}/photos ───────────────────────────────

    private static async Task<IResult> UploadPhotoAsync(
        Guid id,
        [FromForm] IFormFile file,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        if (file is null || file.Length == 0)
            return FamilienResults.BadRequest("file_missing", "Es wurde keine Datei übermittelt.");

        if (file.Length > MaxPhotoBytes)
            return FamilienResults.BadRequest(
                "file_too_large",
                $"Das Foto überschreitet das Limit von {MaxPhotoBytes / (1024 * 1024)} MB.");

        if (!AllowedPhotoContentTypes.Contains(file.ContentType ?? string.Empty))
            return FamilienResults.BadRequest(
                "unsupported_media_type",
                "Nur JPEG-, PNG- und WebP-Bilder sind zulässig.");

        if (recipe.Photos.Count >= Recipe.MaxPhotos)
            return FamilienResults.BadRequest(
                "photo_limit_reached",
                $"Ein Rezept darf höchstens {Recipe.MaxPhotos} Fotos haben.");

        string path;
        await using (var stream = file.OpenReadStream())
        {
            path = await photoStorage.UploadAsync(stream, file.ContentType!, file.FileName, ct);
        }

        try
        {
            // DB holds the bare path; the public URL is computed per-response
            // so each client gets a fresh expiry.
            recipe.AddPhoto(path);
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            // Best-effort rollback — we just stored a photo we can't reference.
            await photoStorage.DeleteAsync(path, ct);
            throw;
        }

        return Results.Ok(new UploadPhotoResponse(photoStorage.GetPublicUrl(path)));
    }

    // ── POST /api/recipes/photos/staged (P2-8) ──────────────────────

    /// <summary>
    /// P2-8 staged-photo upload for the "Rezept aus Foto importieren"
    /// flow. Unlike <see cref="UploadPhotoAsync"/> this variant is NOT
    /// tied to a recipe — the caller is preparing photos to feed into
    /// the Python vision pipeline, and no <see cref="Recipe"/> row
    /// exists yet. On success we return the bare storage path
    /// (<c>photoId</c>) plus a freshly-signed public URL; the import
    /// enqueue endpoint (<c>POST /api/recipes/import/photos</c>) will
    /// verify the signature before kicking off extraction.
    ///
    /// Deliberately reuses <see cref="IPhotoStorage.UploadAsync"/> so
    /// storage-path normalization and content-type → extension
    /// derivation stay in one place. The objects sit next to the real
    /// recipe photos under the <c>recipes/</c> prefix because the
    /// photo-proxy endpoint already serves everything under that path
    /// uniformly — a dedicated <c>recipes/staged/</c> subdirectory
    /// doesn't buy extra isolation (the signed-URL verifier is the
    /// actual access control) and would fragment the storage layout
    /// for a transient benefit only. Abandoned staged photos live
    /// until the future P3 sweep job reaps them.
    ///
    /// Validation order mirrors <see cref="UploadPhotoAsync"/> so the
    /// error taxonomy is identical for both upload paths:
    /// <list type="number">
    /// <item>Auth.</item>
    /// <item>File presence.</item>
    /// <item>File size (5 MB cap).</item>
    /// <item>MIME allowlist (JPEG/PNG/WebP).</item>
    /// </list>
    /// </summary>
    private static async Task<IResult> UploadStagedPhotoAsync(
        [FromForm] IFormFile file,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        if (file is null || file.Length == 0)
            return FamilienResults.BadRequest("file_missing", "Es wurde keine Datei übermittelt.");

        if (file.Length > MaxPhotoBytes)
            return FamilienResults.BadRequest(
                "file_too_large",
                $"Das Foto überschreitet das Limit von {MaxPhotoBytes / (1024 * 1024)} MB.");

        if (!AllowedPhotoContentTypes.Contains(file.ContentType ?? string.Empty))
            return FamilienResults.BadRequest(
                "unsupported_media_type",
                "Nur JPEG-, PNG- und WebP-Bilder sind zulässig. Bitte als JPG/PNG speichern.");

        string path;
        await using (var stream = file.OpenReadStream())
        {
            path = await photoStorage.UploadAsync(stream, file.ContentType!, file.FileName, ct);
        }

        var signedUrl = photoStorage.GetPublicUrl(path);

        // Persist a StagedPhoto row alongside the SeaweedFS upload so
        // the create-recipe promote flow can verify ownership + adopt
        // the blob. If EF blows up after the blob is in place we
        // surface the error so the caller can retry — the abandoned
        // blob is reaped by the hourly sweep job.
        var staged = new StagedPhoto(
            userId: userId,
            photoId: path,
            signedUrl: signedUrl,
            contentType: file.ContentType!,
            createdAt: clock.GetUtcNow());
        db.StagedPhotos.Add(staged);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new StagedPhotoResponse(
            PhotoId: path,
            SignedUrl: signedUrl,
            StagedPhotoId: staged.Id));
    }

    // ── DELETE /api/staged-photos/{id} (BUG-024) ───────────────────

    /// <summary>
    /// BUG-024 — lets the review form drop an unwanted import-uploaded
    /// staged photo before the user saves the recipe. The hourly
    /// <see cref="Jobs.SweepAbandonedStagedPhotosJob"/> is the timeout
    /// fallback for the abandon-the-flow case; this endpoint covers the
    /// user-initiated "I don't want this photo after all" path.
    ///
    /// Ownership is enforced: only the uploader can delete. Already-
    /// promoted rows (PromotedAt != null) are treated as 404 so the
    /// caller can't retroactively unpick a photo from a saved recipe
    /// via this endpoint — they should hit the per-recipe photo-remove
    /// instead.
    ///
    /// Blob delete is best-effort — if SeaweedFS is down the row is
    /// still removed (an orphan blob is benign and the sweep cleans up
    /// the filer if we ever re-introduce one).
    /// </summary>
    private static async Task<IResult> DeleteStagedPhotoAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var row = await db.StagedPhotos.FirstOrDefaultAsync(s => s.Id == id, ct);
        if (row is null || row.PromotedAt != null)
        {
            return FamilienResults.NotFound(
                "not_found",
                "Das Foto ist nicht mehr vorhanden.");
        }
        if (row.UserId != userId)
        {
            return FamilienResults.Forbidden(
                "not_owner",
                "Nur der Uploader darf dieses Foto entfernen.");
        }

        db.StagedPhotos.Remove(row);
        await db.SaveChangesAsync(ct);

        try
        {
            await photoStorage.DeleteAsync(row.PhotoId, ct);
        }
        catch
        {
            // Best-effort — the row is gone; an orphan blob is fine.
        }

        return Results.NoContent();
    }

    // ── DELETE /api/recipes/{id}/photos ─────────────────────────────

    private static async Task<IResult> RemovePhotoAsync(
        Guid id,
        [FromBody] RemovePhotoRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        if (string.IsNullOrWhiteSpace(body.Url))
            return FamilienResults.BadRequest("invalid_input", "url ist erforderlich.");

        // Clients may echo back either the signed URL they received or the
        // bare path; normalize before removing so both shapes work.
        var targetPath = SeaweedFsPhotoStorage.NormalizeToPath(body.Url);
        if (string.IsNullOrWhiteSpace(targetPath))
            return FamilienResults.BadRequest("invalid_input", "url ist erforderlich.");

        var removed = recipe.RemovePhoto(targetPath);
        if (!removed)
            return Results.NotFound();

        await db.SaveChangesAsync(ct);
        await photoStorage.DeleteAsync(targetPath, ct);

        return Results.NoContent();
    }

    // ── POST /api/recipes/{id}/fork ─────────────────────────────────

    /// <summary>
    /// Forks a recipe into another group (PRD §4.7). The current user must
    /// be a member of BOTH the source recipe's group AND the target group.
    /// The new recipe carries <see cref="Recipe.ForkOfRecipeId"/> pointing
    /// at the source. Global tags copy verbatim; group-scoped (custom)
    /// tags are best-effort matched by (Name, Category) in the target
    /// group — unmatched custom tags are dropped with a warning in the
    /// log. Photos are shared by path reference (same underlying files in
    /// SeaweedFS); see S5 Deviations in the progress tracker for the
    /// rationale.
    /// </summary>
    private static async Task<IResult> ForkRecipeAsync(
        Guid id,
        [FromBody] ForkRecipeRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        IRecipeRevisionService revisionService,
        TimeProvider clock,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var logger = loggerFactory.CreateLogger("FamilienKochbuch.Api.RecipeFork");

        if (body.TargetGroupId == Guid.Empty)
            return FamilienResults.BadRequest("invalid_input", "targetGroupId ist erforderlich.");

        var source = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (source is null) return Results.NotFound();

        // Membership of source group is required — even the recipe's
        // existence is effectively a 404-worthy leak for a non-member, but
        // we return 403 here because the recipe id was guessed right, so
        // the caller already knows it exists. Both responses are secure;
        // 403 matches the rest of the API's RBAC semantics.
        if (!await IsGroupMemberAsync(db, source.GroupId, userId, ct))
            return Results.Forbid();

        // Target group membership is likewise required.
        var targetGroup = await db.Groups
            .FirstOrDefaultAsync(g => g.Id == body.TargetGroupId && g.DeletedAt == null, ct);
        if (targetGroup is null)
            return Results.NotFound();
        if (!await IsGroupMemberAsync(db, body.TargetGroupId, userId, ct))
            return Results.Forbid();

        var now = clock.GetUtcNow();
        Recipe fork;
        try
        {
            fork = new Recipe(
                groupId: body.TargetGroupId,
                createdByUserId: userId,
                title: source.Title,
                description: source.Description,
                defaultServings: source.DefaultServings,
                prepTimeMinutes: source.PrepTimeMinutes,
                difficulty: source.Difficulty,
                sourceUrl: source.SourceUrl,
                sourceType: source.SourceType,
                forkOfRecipeId: source.Id,
                createdAt: now);

            foreach (var ing in source.Ingredients.OrderBy(i => i.Position))
            {
                fork.Ingredients.Add(new Ingredient(
                    recipeId: fork.Id,
                    position: ing.Position,
                    quantity: ing.Quantity,
                    unit: ing.Unit,
                    name: ing.Name,
                    note: ing.Note,
                    scalable: ing.Scalable));
            }

            foreach (var step in source.Steps.OrderBy(s => s.Position))
            {
                fork.Steps.Add(new RecipeStep(fork.Id, step.Position, step.Content));
            }

            // Photos: copy path references verbatim. Source and fork share
            // the underlying files in object storage — see Deviations: this
            // Phase 1 policy avoids doubling storage, at the cost of
            // deletes on the source also nulling out fork references. A
            // future slice may move to reference-counting or copy-on-fork.
            foreach (var photo in source.Photos)
            {
                fork.AddPhoto(photo);
            }

            // Tag handling: global tags kept verbatim; group-scoped custom
            // tags matched by (Name, Category) in the target group —
            // unmatched are dropped with a warning.
            if (source.RecipeTags.Count > 0)
            {
                var tagIds = source.RecipeTags.Select(rt => rt.TagId).ToArray();
                var sourceTags = await db.Tags.Where(t => tagIds.Contains(t.Id)).ToListAsync(ct);

                foreach (var sourceTag in sourceTags)
                {
                    if (sourceTag.GroupId is null)
                    {
                        // Global tag — preserve id.
                        fork.RecipeTags.Add(new RecipeTag(fork.Id, sourceTag.Id));
                        continue;
                    }

                    // Group-scoped tag. If the source is the target group
                    // (same-group fork), the tag is already valid; keep
                    // the id.
                    if (sourceTag.GroupId == body.TargetGroupId)
                    {
                        fork.RecipeTags.Add(new RecipeTag(fork.Id, sourceTag.Id));
                        continue;
                    }

                    // Otherwise, look for a matching (Name, Category) in
                    // the target group.
                    var match = await db.Tags.FirstOrDefaultAsync(t =>
                        t.GroupId == body.TargetGroupId
                        && t.Category == sourceTag.Category
                        && t.Name == sourceTag.Name, ct);
                    if (match is null)
                    {
                        logger.LogWarning(
                            "Fork of recipe {SourceRecipeId} dropped tag {TagName} ({TagCategory}) because target group {TargetGroupId} has no matching custom tag.",
                            source.Id, sourceTag.Name, sourceTag.Category, body.TargetGroupId);
                        continue;
                    }
                    fork.RecipeTags.Add(new RecipeTag(fork.Id, match.Id));
                }
            }

            db.Recipes.Add(fork);
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        // S6 follow-up from S5: emit a Created revision on the fork itself
        // with a German hint that surfaces the source. We mention the
        // source recipe's title and originating group so the history
        // panel reads naturally even when the original is in a group the
        // current user can't reach.
        var sourceGroupName = await db.Groups
            .Where(g => g.Id == source.GroupId)
            .Select(g => g.Name)
            .FirstOrDefaultAsync(ct) ?? "anderer Gruppe";
        var sourceDescription = $"Geforkt aus Gruppe {sourceGroupName}: {source.Title}";
        await revisionService.RecordAsync(
            fork.Id, userId, RecipeChangeType.Created, clock.GetUtcNow(), ct,
            sourceDescription: sourceDescription);

        // Reload to project detail (e.g. ordered children, tag details).
        var reloaded = (await LoadRecipeWithChildrenAsync(db, fork.Id, ct))!;
        var detail = await ProjectDetailAsync(db, reloaded, photoStorage, ct);
        return Results.Created($"/api/recipes/{fork.Id}", detail);
    }

    // ── PATCH /api/recipes/{id}/nutrition (P2-10) ───────────────────

    /// <summary>
    /// Replaces the per-portion nutrition estimate on a recipe.
    ///
    /// Request body: nullable <see cref="NutritionEstimateRequest"/> —
    /// ``null`` clears any stored estimate; a populated object stores
    /// it. Bounds (kcal 0..5000, macros 0..500) are enforced by the
    /// domain record; anything outside returns ``400 invalid_input``.
    ///
    /// RBAC: author OR site-admin only. Other group members see ``403``
    /// even though they can read the recipe — estimating nutrition
    /// edits reviewer-visible state.
    /// </summary>
    private static async Task<IResult> PatchNutritionAsync(
        Guid id,
        [FromBody] NutritionEstimateRequest? body,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        // Author or admin. Group membership alone isn't enough — matches
        // the plan's "admin OR author" language.
        if (recipe.CreatedByUserId != userId && !principal.IsAdmin())
            return Results.Forbid();

        try
        {
            var estimate = body is null
                ? null
                : new Domain.Entities.NutritionEstimate(
                    body.Kcal, body.ProteinG, body.CarbsG, body.FatG);
            recipe.SetNutritionEstimate(estimate, clock.GetUtcNow());
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return Results.Ok(detail);
    }

    // ── POST /api/recipes/{id}/cook ─────────────────────────────────

    /// <summary>
    /// DS5 "Jetzt gekocht" action. Marks the recipe as cooked right now by
    /// stamping <see cref="Recipe.LastCookedAt"/> with the current UTC time
    /// and returns the refreshed detail DTO. Requires group membership.
    ///
    /// Explicitly does NOT append a <c>RecipeRevision</c> — cooking is an
    /// activity signal consumed by the recipe-search recency sort, not a
    /// change to the recipe content. Writing a revision every time a user
    /// taps "Jetzt gekocht" would drown the history panel in noise.
    /// </summary>
    private static async Task<IResult> MarkCookedAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        recipe.MarkCooked(clock.GetUtcNow());
        await db.SaveChangesAsync(ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return Results.Ok(detail);
    }

    // ── POST /api/recipes/{id}/reimport (REIMPORT-0) ────────────────

    /// <summary>
    /// REIMPORT-0 — enqueues a fresh URL-extraction run against the
    /// recipe's own <see cref="Recipe.SourceUrl"/>, with a
    /// <see cref="RecipeImport.TargetRecipeId"/> back-pointer that
    /// instructs <see cref="Jobs.ExtractRecipeFromUrlJob"/> to overwrite
    /// the current recipe row in place on success (rather than create a
    /// new one via the PF1 promote-flow).
    ///
    /// <para>
    /// Security model:
    /// <list type="bullet">
    /// <item>URL is read straight from the freshly-loaded recipe — NEVER
    /// from any client-provided body. A hostile caller therefore cannot
    /// redirect the extractor at an arbitrary host; the reimport is
    /// strictly scoped to the saved SourceUrl.</item>
    /// <item>404 (IDOR-hide) is returned for both a missing recipe AND
    /// a member-mismatch so a non-member can't probe recipe ids.</item>
    /// <item>OFF3 <c>If-Match: W/"{id}-{version}"</c> honoured when
    /// supplied; an absent header is tolerated for parity with PUT /
    /// PATCH / DELETE. A stale value yields 409 with the current DTO
    /// payload, matching the other endpoints' contract.</item>
    /// <item>Photo-imported recipes are refused up front (400
    /// <c>photo_import_reimport_not_supported</c>) — the photo
    /// pipeline has no URL to re-fetch; the sentinel
    /// <see cref="PhotoSourceSentinel"/> lives on the recipe row for
    /// provenance only.</item>
    /// </list>
    /// </para>
    ///
    /// On success the handler returns 202 Accepted with
    /// <see cref="ImportEndpoints.ImportEnqueueResponse"/> so the
    /// frontend can start polling <c>GET /api/imports/{id}</c> the
    /// same way the standard URL-import flow does.
    /// </summary>
    private static async Task<IResult> ReimportRecipeAsync(
        Guid id,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        Hangfire.IBackgroundJobClient jobs,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        // Load WITH children — we need them for the current-DTO payload
        // embedded in the 409 conflict body, and loading once avoids a
        // second round-trip after the guards pass.
        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        // IDOR-hide: non-members see the same 404 as a missing recipe.
        // Using NotFound (not Forbid) keeps the existence of the id out
        // of the probe surface.
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.NotFound();

        if (string.IsNullOrWhiteSpace(recipe.SourceUrl))
        {
            return FamilienResults.BadRequest(
                "source_url_missing",
                "Dieses Rezept hat keine Quell-URL — Reimport ist nur für URL-Imports möglich.");
        }

        if (recipe.SourceUrl.StartsWith(PhotoSourceSentinel, StringComparison.Ordinal))
        {
            return FamilienResults.BadRequest(
                "photo_import_reimport_not_supported",
                "Reimport ist für Foto-Imports nicht möglich — es gibt keine URL zum erneuten Abrufen.");
        }

        // REIMPORT-0 hardening — defence-in-depth scheme guard. The
        // initial URL-import endpoint enforces http(s) via
        // `TryNormalizeHttpUrl`, but the PUT /api/recipes/{id} path only
        // validates length on the SourceUrl column, so a member with
        // edit rights could have persisted a non-http scheme between
        // the original import and this reimport. Refuse to hand a
        // `file://` / `gopher://` / `javascript:` URL to the Python
        // extractor — the Python side has its own SSRF guards, but
        // this boundary catches it at the API edge where we still have
        // a clean user-facing error to render.
        if (!Uri.TryCreate(recipe.SourceUrl, UriKind.Absolute, out var storedUri)
            || (storedUri.Scheme != Uri.UriSchemeHttp
                && storedUri.Scheme != Uri.UriSchemeHttps))
        {
            return FamilienResults.BadRequest(
                "invalid_source_url",
                "Die gespeicherte Quell-URL ist ungültig — Reimport ist nur für http(s)-URLs möglich.");
        }

        // OFF3 If-Match guard. The existing helper short-circuits when
        // no header is supplied (backward-compat) and returns a ready-
        // made 409 with the current DTO when a stale value arrives.
        var currentDtoForConflict = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        var conflict = ETagHelper.RequireMatchingVersion(
            httpRequest, recipe, () => recipe.Id, currentDtoForConflict);
        if (conflict is not null) return conflict;

        // REIMPORT-0 — create a new import row that points back at the
        // recipe via TargetRecipeId. The extractor job branches on this
        // to update in place instead of creating a new recipe.
        //
        // SECURITY: SourceUrl is read straight from the DB-loaded recipe
        // above — NEVER trust a caller-supplied URL here. The reimport
        // endpoint body is empty by design so there's no request-side
        // URL field to worry about.
        var import = new RecipeImport(
            userId: userId,
            groupId: recipe.GroupId,
            source: ImportSource.Url,
            sourceUrl: recipe.SourceUrl,
            createdAt: clock.GetUtcNow(),
            targetRecipeId: recipe.Id);
        db.RecipeImports.Add(import);
        await db.SaveChangesAsync(ct);

        jobs.Enqueue<Jobs.ExtractRecipeFromUrlJob>(j =>
            j.ExecuteAsync(import.Id, CancellationToken.None));

        return Results.Accepted(
            $"/api/imports/{import.Id}",
            new ImportEndpoints.ImportEnqueueResponse(import.Id));
    }

    // ── GET /api/groups/{groupId}/tags ──────────────────────────────

    private static async Task<IResult> ListGroupTagsAsync(
        Guid groupId,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var raw = await db.Tags
            .Where(t => t.GroupId == null || t.GroupId == groupId)
            .Select(t => new TagDto(
                t.Id,
                t.Name,
                t.Category.ToString(),
                t.CreatedByUserId == null && t.GroupId == null,
                t.GroupId,
                t.CreatedByUserId))
            .ToArrayAsync(ct);

        // Sort client-side for culture-aware comparison; set sizes are small
        // (low tens of tags in practice).
        var sorted = raw
            .OrderBy(t => t.Category, StringComparer.Ordinal)
            .ThenBy(t => t.Name, StringComparer.CurrentCulture)
            .ToArray();

        return Results.Ok(sorted);
    }

    // ── POST /api/groups/{groupId}/tags ─────────────────────────────────

    private static async Task<IResult> CreateGroupTagAsync(
        Guid groupId,
        CreateTagRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        if (!Enum.TryParse<TagCategory>(body.Category, ignoreCase: false, out var category))
            return FamilienResults.BadRequest("invalid_category",
                "Kategorie ist unbekannt.");

        // Per PRD §4.2 "Custom" is the intended free-form bucket. Custom tags
        // always land in that bucket regardless of what the client sends so
        // the global taxonomy stays authoritative — the endpoint only
        // accepts a name, the rest is domain policy.
        _ = category;

        Domain.Entities.Tag newTag;
        try
        {
            newTag = Domain.Entities.Tag.CreateGroupScoped(userId, groupId, body.Name);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        // Duplicate-before-save check so the response is a clean 400 rather
        // than a DbUpdateException via the unique index.
        var duplicate = await db.Tags.AnyAsync(t =>
            t.GroupId == groupId && t.Category == newTag.Category && t.Name == newTag.Name, ct);
        if (duplicate)
            return FamilienResults.BadRequest("tag_exists",
                "Ein Tag mit diesem Namen existiert bereits in dieser Gruppe.");

        db.Tags.Add(newTag);
        await db.SaveChangesAsync(ct);

        var dto = new TagDto(
            newTag.Id, newTag.Name, newTag.Category.ToString(),
            newTag.IsGlobal, newTag.GroupId, newTag.CreatedByUserId);
        return Results.Created($"/api/groups/{groupId}/tags/{newTag.Id}", dto);
    }

    // ── DELETE /api/groups/{groupId}/tags/{tagId} ───────────────────────

    private static async Task<IResult> DeleteGroupTagAsync(
        Guid groupId,
        Guid tagId,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();

        var membership = await db.GroupMemberships
            .FirstOrDefaultAsync(m => m.GroupId == groupId && m.UserId == userId, ct);
        if (membership is null) return Results.Forbid();

        var tag = await db.Tags.FirstOrDefaultAsync(t => t.Id == tagId, ct);
        if (tag is null) return Results.NotFound();

        // Global tags are managed via the seed migration — endpoint can't
        // touch them. Protect that boundary explicitly.
        if (tag.GroupId is null)
            return FamilienResults.BadRequest("global_tag_protected",
                "Globale Tags können nicht gelöscht werden.");

        if (tag.GroupId != groupId)
            return Results.NotFound();

        // Only group admins may delete custom tags (PRD §10.6: Gruppen-Admin
        // scope). Non-admin members see 403.
        if (membership.Role != Domain.Enums.GroupRole.Admin)
            return Results.Forbid();

        db.Tags.Remove(tag);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    /// <summary>Logger category marker for the staged-photo promote flow.</summary>
    private sealed class PromoteStagedPhotosLogCategory;
}
