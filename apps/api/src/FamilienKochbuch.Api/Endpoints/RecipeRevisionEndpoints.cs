using System.Security.Claims;
using System.Text.Json;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// S6 history endpoints. Two routes only — list metadata + fetch one
/// snapshot — so the front-end can render the "Letzte Änderungen" panel
/// without paying for a full snapshot per row up front.
/// </summary>
public static class RecipeRevisionEndpoints
{
    private static readonly JsonSerializerOptions SnapshotJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    // ── DTO records ─────────────────────────────────────────────────────

    public record ChangedByDto(Guid UserId, string DisplayName);

    public record RevisionSummaryDto(
        Guid Id,
        string ChangeType,
        ChangedByDto ChangedBy,
        string? DiffSummary,
        DateTimeOffset CreatedAt);

    public record IngredientSnapshotDto(
        int Position,
        decimal? Quantity,
        string Unit,
        string Name,
        string? Note,
        bool Scalable);

    public record StepSnapshotDto(int Position, string Content);

    public record RecipeSnapshotDto(
        string Title,
        string? Description,
        int DefaultServings,
        int? PrepTimeMinutes,
        int Difficulty,
        string? SourceUrl,
        IngredientSnapshotDto[] Ingredients,
        StepSnapshotDto[] Steps,
        Guid[] TagIds);

    public record RevisionDetailDto(
        Guid Id,
        string ChangeType,
        ChangedByDto ChangedBy,
        string? DiffSummary,
        DateTimeOffset CreatedAt,
        RecipeSnapshotDto Snapshot);

    // ── Endpoint wiring ─────────────────────────────────────────────────

    public static void MapRecipeRevisionEndpoints(this WebApplication app)
    {
        var revisions = app.MapGroup("/api/recipes/{id:guid}/revisions")
            .WithTags("RecipeRevisions")
            .RequireAuthorization();
        revisions.MapGet("/", ListRevisionsAsync);
        revisions.MapGet("/{revisionId:guid}", GetRevisionAsync);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }

    private static Task<bool> IsGroupMemberAsync(AppDbContext db, Guid groupId, Guid userId, CancellationToken ct) =>
        db.GroupMemberships.AnyAsync(m => m.GroupId == groupId && m.UserId == userId, ct);

    // ── GET /api/recipes/{id}/revisions ─────────────────────────────────

    private static async Task<IResult> ListRevisionsAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        IRecipeRevisionService revisionService,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        var revisions = await revisionService.GetLastAsync(id, take: 5, ct);

        // Single batch lookup of display names for all distinct authors —
        // keeps history rendering O(1) DB round-trips on the read path.
        var userIds = revisions.Select(r => r.ChangedByUserId).Distinct().ToArray();
        var displayNames = await db.Users
            .Where(u => userIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var dtos = revisions
            .Select(r => new RevisionSummaryDto(
                r.Id,
                r.ChangeType.ToString(),
                new ChangedByDto(
                    r.ChangedByUserId,
                    displayNames.GetValueOrDefault(r.ChangedByUserId) ?? string.Empty),
                r.DiffSummary,
                r.CreatedAt))
            .ToArray();

        return Results.Ok(dtos);
    }

    // ── GET /api/recipes/{id}/revisions/{revisionId} ────────────────────

    private static async Task<IResult> GetRevisionAsync(
        Guid id,
        Guid revisionId,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var recipe = await db.Recipes.FirstOrDefaultAsync(r => r.Id == id && r.DeletedAt == null, ct);
        if (recipe is null) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, recipe.GroupId, userId, ct)) return Results.Forbid();

        var revision = await db.RecipeRevisions
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == revisionId && r.RecipeId == id, ct);
        if (revision is null) return Results.NotFound();

        var displayName = await db.Users
            .Where(u => u.Id == revision.ChangedByUserId)
            .Select(u => u.DisplayName)
            .FirstOrDefaultAsync(ct) ?? string.Empty;

        var snapshot = JsonSerializer.Deserialize<RecipeRevisionService.RecipeSnapshot>(
            revision.SnapshotJson, SnapshotJsonOptions);
        if (snapshot is null)
            return Results.Problem("Revision snapshot konnte nicht gelesen werden.");

        var snapshotDto = new RecipeSnapshotDto(
            snapshot.Title,
            snapshot.Description,
            snapshot.DefaultServings,
            snapshot.PrepTimeMinutes,
            snapshot.Difficulty,
            snapshot.SourceUrl,
            snapshot.Ingredients
                .OrderBy(i => i.Position)
                .Select(i => new IngredientSnapshotDto(
                    i.Position, i.Quantity, i.Unit, i.Name, i.Note, i.Scalable))
                .ToArray(),
            snapshot.Steps
                .OrderBy(s => s.Position)
                .Select(s => new StepSnapshotDto(s.Position, s.Content))
                .ToArray(),
            snapshot.TagIds.ToArray());

        return Results.Ok(new RevisionDetailDto(
            revision.Id,
            revision.ChangeType.ToString(),
            new ChangedByDto(revision.ChangedByUserId, displayName),
            revision.DiffSummary,
            revision.CreatedAt,
            snapshotDto));
    }
}
