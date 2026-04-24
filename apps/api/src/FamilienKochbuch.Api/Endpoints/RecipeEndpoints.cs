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
    /// COMP-0 — one sub-recipe group inside the nested
    /// <see cref="CreateRecipeRequest.Components"/> /
    /// <see cref="UpdateRecipeRequest.Components"/> arrays. <see cref="Label"/>
    /// is nullable — a single-block recipe carries one component with
    /// <c>Label = null</c> and <c>Position = 0</c>, while recipes with
    /// visible sub-blocks ("Ingredients (Sauce):") surface with multiple
    /// components in emit-order. Per-component <see cref="Ingredients"/>
    /// + <see cref="Steps"/> replace the previous flat arrays.
    /// </summary>
    public record RecipeComponentRequest(
        int Position,
        string? Label,
        IngredientRequest[] Ingredients,
        StepRequest[] Steps);

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
        // COMP-0 — nested-components shape replaces the previous flat
        // Ingredients + Steps arrays. Must contain ≥1 component; each
        // component carries its own ingredients + steps. See design doc
        // docs/plans/2026-04-21-recipe-components-design.md.
        RecipeComponentRequest[] Components,
        Guid[] TagIds,
        // P2-10: optional per-portion nutrition estimate. ``null`` when
        // the caller can't supply one (manual recipe, legacy client).
        NutritionEstimateRequest? NutritionEstimate = null,
        // Optional StagedPhoto.Id values the server adopts onto the
        // new recipe (ownership-checked, blobs copied into the recipe
        // namespace). Per-photo failures surface via
        // ``partialPhotoFailures`` instead of failing the request.
        Guid[]? StagedPhotoIds = null,
        // COVER-0: optional cover override. When set, must be present
        // in ``StagedPhotoIds``; the promote flow reorders the array
        // so the cover ends up as Recipe.Photos[0]. When null/absent,
        // falls back to StagedPhotoIds[0] as cover, matching the
        // pre-COVER-0 implicit behaviour.
        Guid? CoverStagedPhotoId = null);

    public record UpdateRecipeRequest(
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        // COMP-0 — see CreateRecipeRequest.Components.
        RecipeComponentRequest[] Components,
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

    /// <summary>
    /// COMP-0 — nested-component projection of a <see cref="RecipeComponent"/>
    /// on detail / create / update responses. <see cref="Ingredients"/>
    /// and <see cref="Steps"/> are already scoped to this component and
    /// ordered by <c>Position</c>.
    /// </summary>
    public record RecipeComponentDto(
        Guid Id,
        int Position,
        string? Label,
        IngredientDto[] Ingredients,
        StepDto[] Steps);

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
        // COMP-0 — nested-components replace the flat Ingredients + Steps
        // arrays. Single-default recipes surface as `[{label:null,
        // position:0, ingredients:[...], steps:[...]}]`.
        RecipeComponentDto[] Components,
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

    /// <summary>COVER-0 — body of <c>POST /api/recipes/:id/cover</c>.
    /// The <see cref="StagedPhotoId"/> must be either already promoted
    /// onto this recipe (reorder photos, demote the current cover to
    /// additional) or an un-promoted candidate of this recipe's
    /// origin-import (promote onto the recipe + swap). Any other
    /// staged-photo ownership returns 400.</summary>
    public record CoverSwapRequest(Guid StagedPhotoId);

    /// <summary>COVER-0 Slice E — response of
    /// <c>GET /api/recipes/:id/origin-import</c>. Surfaces the id of the
    /// <see cref="RecipeImport"/> that produced this recipe so the
    /// RecipeDetailPage can fire the candidates query without having to
    /// carry the id in client-side state. 404 when no linkage exists
    /// (manual recipe OR every candidate has been reaped AND the recipe
    /// wasn't the target of a reimport).</summary>
    public record RecipeOriginImportResponse(Guid ImportId);

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

        // COVER-0: swap the recipe's cover photo. Body carries a
        // staged-photo id that must be either already promoted onto
        // this recipe (re-order existing photos) or an un-promoted
        // candidate of this recipe's origin-import (promote + swap).
        recipe.MapPost("/cover", SetRecipeCoverAsync);

        // COVER-0 Slice E: resolve the recipe's originating
        // RecipeImport id so the detail page can mount the
        // "Cover ändern" modal without threading the id through
        // client state that was already torn down after save.
        recipe.MapGet("/origin-import", GetRecipeOriginImportAsync);

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
            .Include(r => r.Components)
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

        // COMP-0 — group ingredients + steps by component so the response
        // mirrors the nested request shape. Order components by their
        // own Position; inside each component the child arrays stay
        // ordered by their respective Position.
        var ingredientsByComponent = recipe.Ingredients
            .GroupBy(i => i.ComponentId)
            .ToDictionary(g => g.Key, g => g.OrderBy(i => i.Position).ToArray());
        var stepsByComponent = recipe.Steps
            .GroupBy(s => s.ComponentId)
            .ToDictionary(g => g.Key, g => g.OrderBy(s => s.Position).ToArray());
        var components = recipe.Components
            .OrderBy(c => c.Position)
            .Select(c => new RecipeComponentDto(
                c.Id,
                c.Position,
                c.Label,
                ingredientsByComponent.TryGetValue(c.Id, out var ings)
                    ? ings.Select(i => new IngredientDto(i.Id, i.Position, i.Quantity, i.Unit, i.Name, i.Note, i.Scalable)).ToArray()
                    : Array.Empty<IngredientDto>(),
                stepsByComponent.TryGetValue(c.Id, out var sts)
                    ? sts.Select(s => new StepDto(s.Id, s.Position, s.Content)).ToArray()
                    : Array.Empty<StepDto>()))
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
            components,
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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidTag,
                "One or more tags are unknown or do not belong to the group.",
                fieldName: "tagIds");

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

            // COMP-0 — materialize the nested components + children then
            // hand them to the aggregate's invariant-enforcing
            // ReplaceComponents method. Any rule violation (empty set,
            // duplicate positions, foreign-recipe FK) bubbles out as a
            // 400 invalid_input below.
            var (components, ingredients, steps) = MaterializeComponents(recipe.Id, body.Components);
            recipe.ReplaceComponents(components, ingredients, steps);

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
            // REL-4c — map the domain guard's ParamName into a stable
            // (ErrorCode, fieldName) pair so RecipeFormPage can route the
            // 400 to the matching inline field. Unknown ParamNames
            // collapse to the legacy `invalid_input` (no fieldName) so
            // nested / novel guards stay covered. Raw exception text is
            // never forwarded — the frontend keys off the code.
            var (code, fieldName) = MapRecipeValidationError(ex);
            return FamilienResults.BadRequest(
                code, "Invalid recipe payload.", fieldName: fieldName);
        }

        // S6: record the initial Created revision so the history panel
        // shows authorship from day one.
        await revisionService.RecordAsync(
            recipe.Id, userId, RecipeChangeType.Created, clock.GetUtcNow(), ct);

        // COVER-0 — when the caller supplied a coverStagedPhotoId,
        // reorder the promote array so that id lands at Photos[0].
        // The ids stay in the same otherwise-stable caller-provided
        // order. When coverStagedPhotoId is missing from stagedPhotoIds
        // the request is a 400; null is the "default cover = [0]"
        // baseline.
        var promoteIds = body.StagedPhotoIds;
        if (body.CoverStagedPhotoId is { } coverId)
        {
            if (promoteIds is null || !promoteIds.Contains(coverId))
                return FamilienResults.BadRequest(
                    ErrorCodes.CoverNotInStagedSet,
                    "Cover photo must be part of the uploaded set.",
                    fieldName: "coverStagedPhotoId");
            promoteIds = new[] { coverId }
                .Concat(promoteIds.Where(id => id != coverId))
                .ToArray();
        }

        // Sequential + best-effort: a single failed photo doesn't
        // take down the others, and the saved recipe is kept even if
        // every promote fails (the user can re-upload from the detail
        // page).
        var partialFailures = await PromoteStagedPhotosAsync(
            db, photoStorage, clock, promoteLogger,
            recipe, userId, promoteIds, ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct,
            partialPhotoFailures: partialFailures.Count == 0 ? null : partialFailures.ToArray());
        return Results.Created($"/api/recipes/{recipe.Id}", detail);
    }

    /// <summary>English developer-facing error strings surfaced
    /// per-photo by <see cref="PromoteStagedPhotosAsync"/>. The
    /// frontend's partial-failure banner renders these for debugging
    /// / ops visibility; user-facing copy is owned by the frontend
    /// i18n layer (REL-3).</summary>
    private static class PromoteErrors
    {
        public const string NotFound = "Photo not found.";
        public const string NotOwner = "Photo does not belong to the caller.";
        public const string AlreadyPromoted = "Photo is already attached to a recipe.";
        public const string CopyFailed = "Failed to copy the photo blob.";
        public const string SaveFailed = "Failed to persist the photo.";

        public static string LimitReached(int max) =>
            $"Recipe already has the maximum of {max} photos.";
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

    /// <summary>
    /// REL-4c / REL-4d — map a domain-guard <see cref="ArgumentException"/>
    /// raised inside <see cref="CreateRecipeAsync"/> /
    /// <see cref="UpdateRecipeAsync"/> onto a stable (ErrorCode, fieldName)
    /// pair. The ParamName on the exception names the domain parameter
    /// (e.g. <c>title</c>, <c>defaultServings</c>); this helper projects
    /// that onto the REL-4 catalogue + the camelCase <c>fieldName</c> the
    /// frontend's inline field-focus routing (<c>RecipeFormPage</c>,
    /// REL-5e / REL-4d) keys off.
    ///
    /// <para>Unknown / missing ParamNames collapse to the legacy
    /// <see cref="ErrorCodes.InvalidInput"/> with <c>fieldName = null</c>
    /// so the banner fallback keeps working for novel guards.</para>
    ///
    /// <para>REL-4d — <see cref="MaterializeComponents"/> wraps per-row
    /// ctor failures and re-throws with a pre-formatted pathed ParamName
    /// (<c>ingredients[i].amount</c> / <c>steps[i].text</c>) for the
    /// single-default-component case. Those paths short-circuit the
    /// switch below and are emitted verbatim as the wire <c>fieldName</c>
    /// so the FE can focus + scroll the exact row input. Multi-component
    /// payloads fall back to the REL-4c section-level
    /// <c>ingredients</c> / <c>steps</c> hint until REL-4e lands the
    /// 2-deep shape.</para>
    /// </summary>
    internal static (string Code, string? FieldName) MapRecipeValidationError(
        ArgumentException ex)
    {
        // REL-4d — pre-formatted nested paths take precedence. The
        // MissingField / InvalidValue split keeps parity with the simpler
        // top-level fields: blank-name / blank-content → MissingField;
        // everything else (too-long, non-positive quantity) → InvalidValue.
        if (TryMapNestedParamName(ex, out var nestedCode, out var nestedField))
        {
            return (nestedCode, nestedField);
        }

        // REL-4d — section-level ``ingredients`` / ``steps`` ParamNames
        // (emitted either directly by Recipe.ReplaceComponents invariants
        // or via MaterializeComponents' multi-component fallback) also
        // honour the MissingField vs InvalidValue split so blank-row
        // reports surface as missing_field even when the path is
        // coarse-grained.
        var sectionCode = (ex.Message ?? string.Empty).Contains(
            "must not be blank", StringComparison.Ordinal)
            ? ErrorCodes.MissingField
            : ErrorCodes.InvalidValue;

        return ex.ParamName switch
        {
            "title" => (ErrorCodes.InvalidTitle, "title"),
            "description" => (ErrorCodes.InvalidValue, "description"),
            "defaultServings" => (ErrorCodes.InvalidValue, "defaultServings"),
            "prepTimeMinutes" => (ErrorCodes.InvalidValue, "prepTimeMinutes"),
            "difficulty" => (ErrorCodes.InvalidValue, "difficulty"),
            "sourceUrl" => (ErrorCodes.InvalidSourceUrl, "sourceUrl"),
            // Nested-components surface as section-level hints when the
            // nested path shape isn't tractable (multi-component payloads
            // — see MaterializeComponents). The FE's Ref-map can target
            // the Zutaten / Schritte / Komponenten container even without
            // a path parser.
            "ingredients" => (sectionCode, "ingredients"),
            "steps" => (sectionCode, "steps"),
            "components" or "componentRequests"
                => (sectionCode, "components"),
            _ => (ErrorCodes.InvalidInput, null),
        };
    }

    /// <summary>
    /// REL-4d — project a pre-formatted pathed ParamName (emitted by
    /// <see cref="MaterializeComponents"/>) onto a (code, fieldName) pair.
    /// Returns <c>false</c> when the ParamName is not a nested path so
    /// the caller falls through to the top-level switch.
    /// </summary>
    private static bool TryMapNestedParamName(
        ArgumentException ex, out string code, out string? fieldName)
    {
        var name = ex.ParamName;
        if (name is null || (name.IndexOf('[') < 0))
        {
            code = ErrorCodes.InvalidInput;
            fieldName = null;
            return false;
        }

        // Message prefix decides MissingField vs InvalidValue. The
        // Ingredient / RecipeStep ctors use "must not be blank" for
        // missing values and everything else (length, negative quantity)
        // is a generic invalid value.
        var msg = ex.Message ?? string.Empty;
        code = msg.Contains("must not be blank", StringComparison.Ordinal)
            ? ErrorCodes.MissingField
            : ErrorCodes.InvalidValue;
        fieldName = name;
        return true;
    }

    /// <summary>
    /// COMP-0 / REL-4d — materialize the nested component request shape
    /// into domain entities. Does no persistence: returns three lists the
    /// caller (create + update endpoints) hands to
    /// <see cref="Recipe.ReplaceComponents"/>. Thrown
    /// <see cref="ArgumentException"/> instances surface as 400
    /// <c>invalid_input</c> upstream.
    ///
    /// <para>REL-4d: for the single-default-component case (the 99% path
    /// covered by <c>RecipeFormPage</c>'s default flow) per-row ctor
    /// failures are re-thrown with a pathed ParamName like
    /// <c>ingredients[3].amount</c> or <c>steps[1].text</c> so
    /// <see cref="MapRecipeValidationError"/> can emit the exact row
    /// address as the wire <c>fieldName</c>. Multi-component payloads
    /// (ambiguous 1-deep paths) fall back to the section-level
    /// <c>ingredients</c> / <c>steps</c> ParamName until REL-4e lands the
    /// 2-deep <c>components[i].ingredients[j].amount</c> shape. The
    /// position-within-array reflects the caller's array order (matches
    /// <c>RecipeFormPage</c>'s row indices on the wire).</para>
    /// </summary>
    internal static (List<RecipeComponent> Components, List<Ingredient> Ingredients, List<RecipeStep> Steps)
        MaterializeComponents(Guid recipeId, RecipeComponentRequest[]? componentRequests)
    {
        if (componentRequests is null || componentRequests.Length == 0)
            throw new ArgumentException(
                "A recipe must have at least one component.", nameof(componentRequests));

        // REL-4d — the FE only registers per-row refs in the single-
        // default-component layout. Multi-component recipes stay on the
        // section-level hint so we don't emit a path the FE can't
        // disambiguate across components.
        var emitRowPaths = componentRequests.Length == 1;

        var components = new List<RecipeComponent>();
        var ingredients = new List<Ingredient>();
        var steps = new List<RecipeStep>();
        foreach (var componentReq in componentRequests.OrderBy(c => c.Position))
        {
            var component = new RecipeComponent(
                recipeId: recipeId,
                position: componentReq.Position,
                label: componentReq.Label);
            components.Add(component);

            if (componentReq.Ingredients is { } ings)
            {
                // Preserve the caller's array order so row indices in
                // nested fieldName paths match RecipeFormPage's rendered
                // rows. (The final persisted sort still uses Position on
                // read via ProjectDetailAsync.)
                for (var idx = 0; idx < ings.Length; idx++)
                {
                    var ing = ings[idx];
                    try
                    {
                        ingredients.Add(new Ingredient(
                            recipeId: recipeId,
                            componentId: component.Id,
                            position: ing.Position,
                            quantity: ing.Quantity,
                            unit: ing.Unit,
                            name: ing.Name,
                            note: ing.Note,
                            scalable: ing.Scalable));
                    }
                    catch (ArgumentException inner)
                    {
                        // REL-4d: single-default-component → pathed
                        // fieldName; multi-component → section-level
                        // ingredients hint (ParamName="ingredients") until
                        // REL-4e lands the 2-deep shape. The original
                        // message is preserved so
                        // MapRecipeValidationError's MissingField vs
                        // InvalidValue split still works.
                        throw new ArgumentException(
                            inner.Message,
                            paramName: emitRowPaths
                                ? $"ingredients[{idx}].{MapIngredientProp(inner.ParamName)}"
                                : "ingredients",
                            innerException: inner);
                    }
                }
            }

            if (componentReq.Steps is { } sts)
            {
                for (var idx = 0; idx < sts.Length; idx++)
                {
                    var step = sts[idx];
                    try
                    {
                        steps.Add(new RecipeStep(
                            recipeId: recipeId,
                            componentId: component.Id,
                            position: step.Position,
                            content: step.Content));
                    }
                    catch (ArgumentException inner)
                    {
                        // Step rows only carry a single wire prop (``text``)
                        // so the path is always steps[idx].text in the
                        // single-component branch.
                        throw new ArgumentException(
                            inner.Message,
                            paramName: emitRowPaths
                                ? $"steps[{idx}].text"
                                : "steps",
                            innerException: inner);
                    }
                }
            }
        }
        return (components, ingredients, steps);
    }

    /// <summary>
    /// REL-4d — project an Ingredient ctor ParamName onto the camelCase
    /// wire property the frontend's IngredientRow uses. <c>quantity</c>
    /// surfaces as <c>amount</c> because the user-facing input is labelled
    /// "Menge" / "Amount" and the FE row model uses <c>amount</c>
    /// historically. Unknown ParamNames fall back to a generic <c>row</c>
    /// bucket so the FE lands on the row-level container.
    /// </summary>
    private static string MapIngredientProp(string? paramName) => paramName switch
    {
        "quantity" => "amount",
        "scalable" => "amount",
        "name" => "name",
        "unit" => "unit",
        "note" => "note",
        _ => "row",
    };

    /// <summary>
    /// REL-4d — project a RecipeStep ctor ParamName onto the camelCase
    /// wire property for the step row. The textarea is labelled "Schritt
    /// N" and the FE row model uses <c>text</c>; map both <c>content</c>
    /// variants onto it.
    /// </summary>
    private static string MapStepProp(string? paramName) => paramName switch
    {
        "content" => "text",
        _ => "text",
    };

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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidPage,
                "Page must be a positive integer.",
                fieldName: "page");
        }

        var effectivePageSize = pageSize ?? ListDefaultPageSize;
        if (effectivePageSize < 1 || effectivePageSize > MaxPageSize)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidPageSize,
                $"Page size must be between 1 and {MaxPageSize}.",
                fieldName: "pageSize");
        }

        if (!TryParseRecipeSort(sort, out var sortOrder))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidSort,
                "Unknown sort value. Allowed: updated_desc, cooked_desc, title_asc, rating_desc.",
                fieldName: "sort");
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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidQuery,
                $"Query must be between 1 and {SearchQueryMaxLength} characters.",
                fieldName: "q");
        }

        var effectivePage = page ?? 1;
        if (effectivePage < 1)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidPage,
                "Page must be a positive integer.",
                fieldName: "page");
        }

        var effectivePageSize = pageSize ?? ListDefaultPageSize;
        if (effectivePageSize < 1 || effectivePageSize > MaxPageSize)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidPageSize,
                $"Page size must be between 1 and {MaxPageSize}.",
                fieldName: "pageSize");
        }

        if (!TryParseRecipeSearchSort(sort, out var sortOrder))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidSort,
                "Unknown sort value. Allowed: relevance_desc, updated_desc, cooked_desc, title_asc, rating_desc.",
                fieldName: "sort");
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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidTag,
                "One or more tags are unknown or do not belong to the group.",
                fieldName: "tagIds");

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

            // COMP-0 — build the fresh children set up front so any
            // invariant violation (empty components array, cross-recipe
            // FK, duplicate component position) throws BEFORE we issue
            // any DELETEs. Keeps the 400 path side-effect-free.
            var (newComponents, newIngredients, newSteps) =
                MaterializeComponents(recipe.Id, body.Components);
            // Run the domain aggregate's invariant-enforcer against the
            // fresh set so the ≥1-component + unique-position + FK rules
            // fire BEFORE we touch the DB. We detach the resulting
            // entities from the aggregate below so the two-phase write
            // doesn't re-send them as Recipe modifications.
            recipe.ReplaceComponents(newComponents, newIngredients, newSteps);
            recipe.Components.Clear();
            recipe.Ingredients.Clear();
            recipe.Steps.Clear();

            // Wholesale replace: delete existing children in one pass,
            // save, then insert the replacement set. Doing it in two
            // SaveChanges calls avoids optimistic-concurrency and
            // unique-index conflicts when positions overlap between the
            // old and new sets. Mirrors the pre-COMP-0 UpdateRecipeAsync
            // pattern that existing endpoint tests rely on.
            //
            // Order matters: Ingredients + Steps before Components so
            // the ComponentId FK is already gone by the time we drop
            // the component rows (SQLite enforces FK constraints
            // immediately).
            var existingIngredients = await db.Ingredients.Where(i => i.RecipeId == recipe.Id).ToListAsync(ct);
            db.Ingredients.RemoveRange(existingIngredients);
            var existingSteps = await db.RecipeSteps.Where(s => s.RecipeId == recipe.Id).ToListAsync(ct);
            db.RecipeSteps.RemoveRange(existingSteps);
            var existingComponents = await db.RecipeComponents.Where(c => c.RecipeId == recipe.Id).ToListAsync(ct);
            db.RecipeComponents.RemoveRange(existingComponents);
            var existingTags = await db.RecipeTags.Where(rt => rt.RecipeId == recipe.Id).ToListAsync(ct);
            db.RecipeTags.RemoveRange(existingTags);
            await db.SaveChangesAsync(ct);

            // Second phase: insert new components + their children +
            // tag links. Add through the DbSet (not through the
            // aggregate's navigation collection) so EF doesn't register
            // a Recipe-level modification alongside the INSERT batch.
            foreach (var component in newComponents)
                db.RecipeComponents.Add(component);
            foreach (var ingredient in newIngredients)
                db.Ingredients.Add(ingredient);
            foreach (var step in newSteps)
                db.RecipeSteps.Add(step);
            foreach (var tagId in body.TagIds.Distinct())
                db.RecipeTags.Add(new RecipeTag(recipe.Id, tagId));
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            // REL-4c — see CreateRecipeAsync for rationale: map the
            // domain guard's ParamName onto the REL-4 error catalogue +
            // a camelCase fieldName hint so RecipeFormPage can route the
            // 400 to the matching inline input.
            var (code, fieldName) = MapRecipeValidationError(ex);
            return FamilienResults.BadRequest(
                code, "Invalid recipe payload.", fieldName: fieldName);
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
                ErrorCodes.VersionMismatch,
                "Version mismatch; reload and retry.",
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
            return FamilienResults.BadRequest(
                ErrorCodes.FileMissing,
                "No file was uploaded.",
                fieldName: "file");

        if (file.Length > MaxPhotoBytes)
            return FamilienResults.BadRequest(
                ErrorCodes.FileTooLarge,
                $"File exceeds the {MaxPhotoBytes / (1024 * 1024)} MB limit.",
                fieldName: "file");

        if (!AllowedPhotoContentTypes.Contains(file.ContentType ?? string.Empty))
            return FamilienResults.BadRequest(
                ErrorCodes.UnsupportedMediaType,
                "Only JPEG, PNG, and WebP images are accepted.",
                fieldName: "file");

        if (recipe.Photos.Count >= Recipe.MaxPhotos)
            return FamilienResults.BadRequest(
                ErrorCodes.PhotoLimitReached,
                $"A recipe may have at most {Recipe.MaxPhotos} photos.");

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
            return FamilienResults.BadRequest(
                ErrorCodes.FileMissing,
                "No file was uploaded.",
                fieldName: "file");

        if (file.Length > MaxPhotoBytes)
            return FamilienResults.BadRequest(
                ErrorCodes.FileTooLarge,
                $"File exceeds the {MaxPhotoBytes / (1024 * 1024)} MB limit.",
                fieldName: "file");

        if (!AllowedPhotoContentTypes.Contains(file.ContentType ?? string.Empty))
            return FamilienResults.BadRequest(
                ErrorCodes.UnsupportedMediaType,
                "Only JPEG, PNG, and WebP images are accepted. Save as JPG or PNG.",
                fieldName: "file");

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
                ErrorCodes.NotFound, "Photo no longer exists.");
        }
        if (row.UserId != userId)
        {
            return FamilienResults.Forbidden(
                ErrorCodes.NotOwner, "Only the uploader may remove this photo.");
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
            return FamilienResults.BadRequest(
                ErrorCodes.MissingField,
                "url is required.",
                fieldName: "url");

        // Clients may echo back either the signed URL they received or the
        // bare path; normalize before removing so both shapes work.
        var targetPath = SeaweedFsPhotoStorage.NormalizeToPath(body.Url);
        if (string.IsNullOrWhiteSpace(targetPath))
            return FamilienResults.BadRequest(
                ErrorCodes.MissingField,
                "url is required.",
                fieldName: "url");

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
            return FamilienResults.BadRequest(
                ErrorCodes.MissingField,
                "targetGroupId is required.",
                fieldName: "targetGroupId");

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

            // COMP-0 — clone each source component onto the fork and
            // re-wire ingredients + steps through the new ComponentIds.
            // The mapping keeps the same positions so the detail-page
            // ordering is preserved on the fork.
            var sourceToForkComponentId = new Dictionary<Guid, Guid>();
            var forkComponents = new List<RecipeComponent>();
            foreach (var comp in source.Components.OrderBy(c => c.Position))
            {
                var forked = new RecipeComponent(fork.Id, comp.Position, comp.Label);
                sourceToForkComponentId[comp.Id] = forked.Id;
                forkComponents.Add(forked);
            }

            var forkIngredients = new List<Ingredient>();
            foreach (var ing in source.Ingredients.OrderBy(i => i.Position))
            {
                if (!sourceToForkComponentId.TryGetValue(ing.ComponentId, out var forkComponentId))
                    throw new InvalidOperationException(
                        $"Source recipe {source.Id} carries an orphan ingredient {ing.Id}; aborting fork.");
                forkIngredients.Add(new Ingredient(
                    recipeId: fork.Id,
                    componentId: forkComponentId,
                    position: ing.Position,
                    quantity: ing.Quantity,
                    unit: ing.Unit,
                    name: ing.Name,
                    note: ing.Note,
                    scalable: ing.Scalable));
            }

            var forkSteps = new List<RecipeStep>();
            foreach (var step in source.Steps.OrderBy(s => s.Position))
            {
                if (!sourceToForkComponentId.TryGetValue(step.ComponentId, out var forkComponentId))
                    throw new InvalidOperationException(
                        $"Source recipe {source.Id} carries an orphan step {step.Id}; aborting fork.");
                forkSteps.Add(new RecipeStep(
                    recipeId: fork.Id,
                    componentId: forkComponentId,
                    position: step.Position,
                    content: step.Content));
            }

            fork.ReplaceComponents(forkComponents, forkIngredients, forkSteps);

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
        catch (ArgumentException)
        {
            // Domain exception text may leak entity detail. Surface a
            // stable English developer-message; the frontend keys off
            // the code for user-facing copy.
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid recipe payload.");
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
        catch (ArgumentException)
        {
            // Domain exception text may leak entity detail. Surface a
            // stable English developer-message; the frontend keys off
            // the code for user-facing copy.
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid recipe payload.");
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

    // ── POST /api/recipes/{id}/cover (COVER-0) ──────────────────────

    /// <summary>
    /// COVER-0 — swap the recipe's cover photo. Two accepted input
    /// shapes for <see cref="CoverSwapRequest.StagedPhotoId"/>:
    /// <list type="bullet">
    /// <item><b>Already promoted on this recipe</b>: the corresponding
    /// path in <see cref="Recipe.Photos"/> is moved to index 0; the
    /// previous cover becomes the second photo.</item>
    /// <item><b>Un-promoted candidate of this recipe's origin-import</b>:
    /// the staged blob is copied into the recipe namespace, appended at
    /// position 0, and the previous cover demotes to position 1. The
    /// origin-import is discovered by walking any already-promoted
    /// staged photo on this recipe and reading its
    /// <see cref="StagedPhoto.LinkedImportId"/> — a candidate is
    /// accepted only when it shares that import id. This prevents
    /// cross-import staged-photo stealing.</item>
    /// </list>
    ///
    /// Authz: recipe owner (<see cref="Recipe.CreatedByUserId"/>) only —
    /// admin is NOT auto-allowed through; the cover decision is UX-
    /// personal rather than moderation.
    /// </summary>
    private static async Task<IResult> SetRecipeCoverAsync(
        Guid id,
        CoverSwapRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        if (body is null || body.StagedPhotoId == Guid.Empty)
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidStagedPhotoId,
                "A valid stagedPhotoId is required.",
                fieldName: "stagedPhotoId");

        var recipe = await LoadRecipeWithChildrenAsync(db, id, ct);
        if (recipe is null) return Results.NotFound();

        // Owner-only — admin doesn't automatically bypass here.
        if (recipe.CreatedByUserId != userId)
            return FamilienResults.Forbidden(
                ErrorCodes.Forbidden, "You are not the owner of this recipe.");

        var staged = await db.StagedPhotos
            .FirstOrDefaultAsync(s => s.Id == body.StagedPhotoId, ct);
        if (staged is null)
            return FamilienResults.BadRequest(
                ErrorCodes.StagedPhotoNotFound, "Staged photo not found.");

        // Path A: already promoted onto THIS recipe → just reorder.
        if (staged.PromotedAt is not null
            && staged.PromotedToRecipeId == recipe.Id)
        {
            if (!ReorderCover(recipe, staged.PhotoId))
                return FamilienResults.BadRequest(
                    ErrorCodes.CoverNotOnRecipe,
                    "This photo is not attached to the recipe.");
            await db.SaveChangesAsync(ct);
            var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
            return Results.Ok(detail);
        }

        // Path B: un-promoted candidate that belongs to this recipe's
        // origin-import. Find the origin import by consulting any
        // already-promoted StagedPhoto on this recipe; if none exists
        // the candidate can't be linked to this recipe and we refuse.
        if (staged.PromotedAt is null && staged.LinkedImportId is { } linkedImportId)
        {
            // Require (a) candidate belongs to this user AND (b) at
            // least one of the recipe's existing promoted photos shares
            // the same LinkedImportId OR the recipe was created from
            // that import (via TargetRecipeId).
            if (staged.UserId != userId)
                return FamilienResults.BadRequest(
                    ErrorCodes.CoverWrongOwner, "Photo does not belong to you.");

            var importMatches = await db.StagedPhotos.AsNoTracking()
                .AnyAsync(s => s.PromotedToRecipeId == recipe.Id
                    && s.LinkedImportId == linkedImportId, ct);
            if (!importMatches)
            {
                // Fall back to checking RecipeImport.TargetRecipeId so a
                // reimport path where the [0] candidate was demoted /
                // removed still accepts its sibling candidates.
                importMatches = await db.RecipeImports.AsNoTracking()
                    .AnyAsync(i => i.Id == linkedImportId
                        && i.TargetRecipeId == recipe.Id, ct);
            }
            if (!importMatches)
                return FamilienResults.BadRequest(
                    ErrorCodes.CoverNotFromRecipeImport,
                    "Photo does not belong to this recipe's import.");

            if (recipe.Photos.Count >= Recipe.MaxPhotos)
                return FamilienResults.BadRequest(
                    ErrorCodes.PhotoLimitReached,
                    $"A recipe may have at most {Recipe.MaxPhotos} photos.");

            string destinationPath;
            try
            {
                destinationPath = await photoStorage.CopyAsync(
                    staged.PhotoId, staged.ContentType, ct);
            }
            catch (Exception)
            {
                return FamilienResults.BadRequest(
                    ErrorCodes.CoverCopyFailed, "Failed to copy the photo.");
            }

            recipe.AddPhoto(destinationPath);
            ReorderCover(recipe, destinationPath);
            staged.MarkPromoted(recipe.Id, clock.GetUtcNow());
            await db.SaveChangesAsync(ct);

            // Best-effort delete of the staged source blob. Same posture
            // as PromoteStagedPhotosAsync — sweep reaps orphans.
            try
            {
                await photoStorage.DeleteAsync(staged.PhotoId, ct);
            }
            catch { /* sweep reaps orphan blobs */ }

            var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
            return Results.Ok(detail);
        }

        return FamilienResults.BadRequest(
            ErrorCodes.CoverNotFromRecipeImport,
            "Photo does not belong to this recipe's import.");
    }

    // ── GET /api/recipes/{id}/origin-import (COVER-0 Slice E) ──────

    /// <summary>
    /// COVER-0 Slice E — resolves the <see cref="RecipeImport"/> that
    /// originally produced this recipe. Looked up in order:
    /// <list type="number">
    /// <item>Any <see cref="StagedPhoto"/> already promoted onto the
    /// recipe whose <c>LinkedImportId</c> is non-null — this is the
    /// cheap, common path for freshly-imported recipes whose default
    /// cover is still the attached one.</item>
    /// <item>Fallback: a <see cref="RecipeImport"/> whose
    /// <c>TargetRecipeId</c> equals the recipe id. Covers the reimport
    /// path where the [0] candidate was demoted or removed from the
    /// recipe, so no linked StagedPhoto is on it anymore.</item>
    /// </list>
    ///
    /// <para>Response model:</para>
    /// <list type="bullet">
    /// <item>200 <see cref="RecipeOriginImportResponse"/> — match found.</item>
    /// <item>404 — recipe missing OR no import linkage (manual recipe
    /// OR all candidate rows have been promoted+consumed AND this
    /// recipe was not the target of a reimport).</item>
    /// <item>403 — caller is not the recipe owner. No admin bypass; the
    /// origin-import lookup is scoped to the owner's own surfaces (admin
    /// can always query <c>/api/imports/…</c> directly).</item>
    /// <item>401 — anonymous.</item>
    /// </list>
    ///
    /// <para>Security note: the linkage is derived from server-side
    /// tables only (<see cref="StagedPhoto"/> + <see cref="RecipeImport"/>).
    /// The caller cannot supply an import id; the endpoint returns one
    /// the server already committed. Ownership check is on the recipe,
    /// not the import — the import is owned by the same user by
    /// construction (StagedPhotos.UserId matches the recipe creator for
    /// every candidate we'd resolve).</para>
    /// </summary>
    private static async Task<IResult> GetRecipeOriginImportAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.AsNoTracking()
            .Where(r => r.Id == id && r.DeletedAt == null)
            .Select(r => new { r.Id, r.CreatedByUserId })
            .SingleOrDefaultAsync(ct);
        if (recipe is null) return Results.NotFound();

        // Owner-only. No admin bypass — the detail page's "Cover ändern"
        // modal is a first-person surface; admins who need the linkage
        // can query /api/imports directly.
        if (recipe.CreatedByUserId != userId)
            return FamilienResults.Forbidden(
                ErrorCodes.Forbidden, "You are not the owner of this recipe.");

        // Primary lookup: a promoted staged photo on the recipe tells us
        // which import it was captured for.
        var viaPromoted = await db.StagedPhotos.AsNoTracking()
            .Where(s => s.PromotedToRecipeId == id
                && s.LinkedImportId != null)
            .Select(s => (Guid?)s.LinkedImportId!.Value)
            .FirstOrDefaultAsync(ct);
        if (viaPromoted is { } importId)
            return Results.Ok(new RecipeOriginImportResponse(importId));

        // Fallback: reimport path — the recipe is the target of an
        // in-flight / recent RecipeImport whose candidates may never
        // have been promoted onto the recipe yet. Skip SQL ORDER BY on
        // CreatedAt (SQLite can't sort DateTimeOffset server-side); the
        // expected row count per recipe is tiny (0-N reimports in a
        // 7-day window) so the in-memory sort is effectively free.
        var reimports = await db.RecipeImports.AsNoTracking()
            .Where(i => i.TargetRecipeId == id)
            .Select(i => new { i.Id, i.CreatedAt })
            .ToListAsync(ct);
        if (reimports.Count > 0)
        {
            var newest = reimports
                .OrderByDescending(r => r.CreatedAt)
                .First();
            return Results.Ok(new RecipeOriginImportResponse(newest.Id));
        }

        return Results.NotFound();
    }

    /// <summary>Moves <paramref name="photoPath"/> to index 0 of
    /// <see cref="Recipe.Photos"/>, preserving the relative order of the
    /// remaining entries. Returns <c>false</c> when the path isn't in
    /// the list. Bumps Version via Recipe's Remove/Add methods.</summary>
    private static bool ReorderCover(Recipe recipe, string photoPath)
    {
        if (!recipe.Photos.Contains(photoPath)) return false;
        if (recipe.Photos.Count > 0 && recipe.Photos[0] == photoPath) return true;

        // Snapshot the remainder, clear, re-add cover first then the rest
        // in their original relative order. The domain's Add/Remove both
        // bump Version; reorderings count as a single semantic edit.
        var remainder = recipe.Photos.Where(p => p != photoPath).ToList();
        recipe.RemovePhoto(photoPath);
        foreach (var p in remainder) recipe.RemovePhoto(p);
        recipe.AddPhoto(photoPath);
        foreach (var p in remainder) recipe.AddPhoto(p);
        return true;
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
                ErrorCodes.SourceUrlMissing,
                "Recipe has no source URL; reimport is only available for URL imports.");
        }

        if (recipe.SourceUrl.StartsWith(PhotoSourceSentinel, StringComparison.Ordinal))
        {
            return FamilienResults.BadRequest(
                ErrorCodes.PhotoImportReimportNotSupported,
                "Reimport is not supported for photo imports.");
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
                ErrorCodes.InvalidSourceUrl,
                "Stored source URL is invalid; reimport is only available for http(s) URLs.");
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
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidCategory,
                "Unknown tag category.",
                fieldName: "category");

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
        catch (ArgumentException)
        {
            // Domain exception text may leak entity detail. Surface a
            // stable English developer-message; the frontend keys off
            // the code for user-facing copy.
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid recipe payload.");
        }

        // Duplicate-before-save check so the response is a clean 400 rather
        // than a DbUpdateException via the unique index.
        var duplicate = await db.Tags.AnyAsync(t =>
            t.GroupId == groupId && t.Category == newTag.Category && t.Name == newTag.Name, ct);
        if (duplicate)
            return FamilienResults.BadRequest(
                ErrorCodes.TagExists,
                "A tag with this name already exists in this group.");

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
            return FamilienResults.BadRequest(
                ErrorCodes.GlobalTagProtected,
                "Global tags cannot be deleted.");

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
