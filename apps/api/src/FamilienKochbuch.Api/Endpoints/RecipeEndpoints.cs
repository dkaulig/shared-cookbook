using System.Security.Claims;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
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

    public record CreateRecipeRequest(
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        IngredientRequest[] Ingredients,
        StepRequest[] Steps,
        Guid[] TagIds);

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

    public record RecipeSummaryListDto(
        RecipeSummaryDto[] Items,
        int Page,
        int PageSize,
        int Total);

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
        IngredientDto[] Ingredients,
        StepDto[] Steps,
        TagDto[] Tags);

    public record UploadPhotoResponse(string Url);

    public record RemovePhotoRequest(string Url);

    public record ForkRecipeRequest(Guid TargetGroupId);

    public record ErrorResponse(string Code, string Message);

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
        recipe.MapPost("/photos", UploadPhotoAsync).DisableAntiforgery();
        recipe.MapDelete("/photos", RemovePhotoAsync);
        recipe.MapPost("/fork", ForkRecipeAsync);
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
        CancellationToken ct)
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
            ingredients,
            steps,
            tags);
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
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        // Validate tag ids — must be global or scoped to this group.
        if (!await AreTagIdsValidForGroupAsync(db, body.TagIds, groupId, ct))
            return Results.BadRequest(new ErrorResponse("invalid_tag", "Ein oder mehrere Tags sind unbekannt oder gehören nicht zur Gruppe."));

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

            db.Recipes.Add(recipe);
            await db.SaveChangesAsync(ct);
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(new ErrorResponse("invalid_input", ex.Message));
        }

        // S6: record the initial Created revision so the history panel
        // shows authorship from day one.
        await revisionService.RecordAsync(
            recipe.Id, userId, RecipeChangeType.Created, clock.GetUtcNow(), ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return Results.Created($"/api/recipes/{recipe.Id}", detail);
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

    private static async Task<IResult> ListGroupRecipesAsync(
        Guid groupId,
        int? page,
        int? pageSize,
        ClaimsPrincipal principal,
        AppDbContext db,
        IPhotoStorage photoStorage,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var group = await db.Groups.FirstOrDefaultAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (group is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var p = Math.Max(page ?? 1, 1);
        var size = Math.Min(Math.Max(pageSize ?? DefaultPageSize, 1), MaxPageSize);

        var baseQuery = db.Recipes.Where(r => r.GroupId == groupId && r.DeletedAt == null);
        var total = await baseQuery.CountAsync(ct);

        // SQLite can't order by DateTimeOffset server-side (Postgres can),
        // so we page by CreatedAt (DateTimeOffset support is the same),
        // but we just materialize and sort in memory. Page sizes are
        // bounded (≤ 100) so this is fine.
        var all = await baseQuery
            .Join(db.Users, r => r.CreatedByUserId, u => u.Id, (r, u) => new
            {
                Recipe = r,
                CreatorDisplay = u.DisplayName,
            })
            .ToListAsync(ct);

        var rows = all
            .OrderByDescending(x => x.Recipe.UpdatedAt)
            .Skip((p - 1) * size)
            .Take(size)
            .ToList();

        var recipeIds = rows.Select(x => x.Recipe.Id).ToArray();
        var tagMap = await db.RecipeTags
            .Where(rt => recipeIds.Contains(rt.RecipeId))
            .Select(rt => new { rt.RecipeId, rt.TagId })
            .ToListAsync(ct);
        var tagsByRecipe = tagMap
            .GroupBy(x => x.RecipeId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.TagId).ToArray());

        // Rating aggregates per recipe. We pull in one shot and compute
        // avg/count/myStars in memory — rating counts per recipe are small.
        var ratingRows = await db.Ratings
            .Where(r => recipeIds.Contains(r.RecipeId))
            .Select(r => new { r.RecipeId, r.UserId, r.Stars })
            .ToListAsync(ct);
        var ratingsByRecipe = ratingRows.GroupBy(x => x.RecipeId)
            .ToDictionary(g => g.Key, g => g.ToList());

        var items = rows.Select(x =>
        {
            var ratings = ratingsByRecipe.TryGetValue(x.Recipe.Id, out var list) ? list : null;
            double? avg = ratings is null || ratings.Count == 0
                ? null
                : Math.Round(ratings.Average(r => (double)r.Stars), 1);
            int count = ratings?.Count ?? 0;
            int? myStars = ratings?.FirstOrDefault(r => r.UserId == userId)?.Stars;

            var firstPhotoPath = x.Recipe.Photos.FirstOrDefault();
            var firstPhotoUrl = string.IsNullOrEmpty(firstPhotoPath)
                ? null
                : photoStorage.GetPublicUrl(firstPhotoPath);

            return new RecipeSummaryDto(
                x.Recipe.Id,
                x.Recipe.GroupId,
                x.Recipe.Title,
                x.Recipe.Description,
                firstPhotoUrl,
                tagsByRecipe.TryGetValue(x.Recipe.Id, out var ids) ? ids : Array.Empty<Guid>(),
                x.CreatorDisplay,
                x.Recipe.UpdatedAt,
                avg,
                count,
                myStars);
        }).ToArray();

        return Results.Ok(new RecipeSummaryListDto(items, p, size, total));
    }

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
        return Results.Ok(detail);
    }

    // ── PUT /api/recipes/{id} ───────────────────────────────────────

    private static async Task<IResult> UpdateRecipeAsync(
        Guid id,
        UpdateRecipeRequest body,
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

        if (!await AreTagIdsValidForGroupAsync(db, body.TagIds, recipe.GroupId, ct))
            return Results.BadRequest(new ErrorResponse("invalid_tag", "Ein oder mehrere Tags sind unbekannt oder gehören nicht zur Gruppe."));

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
            return Results.BadRequest(new ErrorResponse("invalid_input", ex.Message));
        }

        // Reload to project the detail DTO from fresh state.
        recipe = (await LoadRecipeWithChildrenAsync(db, recipe.Id, ct))!;

        // S6: record an Edited revision. The service is a no-op when the
        // resulting snapshot deep-equals the previous one, so PUTs that
        // don't actually change the body don't pollute history.
        await revisionService.RecordAsync(
            recipe.Id, userId, RecipeChangeType.Edited, clock.GetUtcNow(), ct);

        var detail = await ProjectDetailAsync(db, recipe, photoStorage, ct);
        return Results.Ok(detail);
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
            return Results.BadRequest(new ErrorResponse("file_missing", "Es wurde keine Datei übermittelt."));

        if (file.Length > MaxPhotoBytes)
            return Results.BadRequest(new ErrorResponse(
                "file_too_large",
                $"Das Foto überschreitet das Limit von {MaxPhotoBytes / (1024 * 1024)} MB."));

        if (!AllowedPhotoContentTypes.Contains(file.ContentType ?? string.Empty))
            return Results.BadRequest(new ErrorResponse(
                "unsupported_media_type",
                "Nur JPEG-, PNG- und WebP-Bilder sind zulässig."));

        if (recipe.Photos.Count >= Recipe.MaxPhotos)
            return Results.BadRequest(new ErrorResponse(
                "photo_limit_reached",
                $"Ein Rezept darf höchstens {Recipe.MaxPhotos} Fotos haben."));

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
            return Results.BadRequest(new ErrorResponse("invalid_input", "url ist erforderlich."));

        // Clients may echo back either the signed URL they received or the
        // bare path; normalize before removing so both shapes work.
        var targetPath = SeaweedFsPhotoStorage.NormalizeToPath(body.Url);
        if (string.IsNullOrWhiteSpace(targetPath))
            return Results.BadRequest(new ErrorResponse("invalid_input", "url ist erforderlich."));

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
            return Results.BadRequest(new ErrorResponse("invalid_input", "targetGroupId ist erforderlich."));

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
            return Results.BadRequest(new ErrorResponse("invalid_input", ex.Message));
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
            return Results.BadRequest(new ErrorResponse("invalid_category",
                "Kategorie ist unbekannt."));

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
            return Results.BadRequest(new ErrorResponse("invalid_input", ex.Message));
        }

        // Duplicate-before-save check so the response is a clean 400 rather
        // than a DbUpdateException via the unique index.
        var duplicate = await db.Tags.AnyAsync(t =>
            t.GroupId == groupId && t.Category == newTag.Category && t.Name == newTag.Name, ct);
        if (duplicate)
            return Results.BadRequest(new ErrorResponse("tag_exists",
                "Ein Tag mit diesem Namen existiert bereits in dieser Gruppe."));

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
            return Results.BadRequest(new ErrorResponse("global_tag_protected",
                "Globale Tags können nicht gelöscht werden."));

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
}
