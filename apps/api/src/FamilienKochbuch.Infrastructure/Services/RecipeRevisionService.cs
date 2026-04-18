using System.Text.Json;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Default implementation of <see cref="IRecipeRevisionService"/>. The
/// snapshot serializer is intentionally simple — System.Text.Json over a
/// fixed shape — so revisions remain comparable across schema changes by
/// inspecting the deserialized object rather than chasing entity drift.
/// Pruning runs in the same SaveChangesAsync as the insert so a torn
/// transaction either records the new revision AND drops the oldest, or
/// leaves history untouched.
/// </summary>
public class RecipeRevisionService(AppDbContext db) : IRecipeRevisionService
{
    public const int RetainCount = 5;

    private static readonly JsonSerializerOptions SnapshotJsonOptions = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public async Task RecordAsync(
        Guid recipeId,
        Guid changedByUserId,
        RecipeChangeType changeType,
        DateTimeOffset now,
        CancellationToken ct,
        string? sourceDescription = null)
    {
        var recipe = await db.Recipes
            .Include(r => r.Ingredients)
            .Include(r => r.Steps)
            .Include(r => r.RecipeTags)
            .AsNoTracking()
            .FirstOrDefaultAsync(r => r.Id == recipeId, ct);
        if (recipe is null)
            return;

        var snapshot = BuildSnapshot(recipe);
        var snapshotJson = JsonSerializer.Serialize(snapshot, SnapshotJsonOptions);

        // Look up the previous revision for diff computation + no-op detection.
        // SQLite cannot ORDER BY DateTimeOffset server-side; materialize the
        // (small — capped at 5) set and sort in memory. Postgres pushes the
        // same expression down to the server. We track the entities here
        // because the prune pass below issues DELETEs against this exact
        // set, and re-attaching detached copies can collide with whatever
        // the DbContext already tracks from upstream operations.
        var existingRevisions = await db.RecipeRevisions
            .Where(r => r.RecipeId == recipeId)
            .ToListAsync(ct);
        var previous = existingRevisions
            .OrderByDescending(r => r.CreatedAt)
            .FirstOrDefault();

        string? diffSummary = null;
        if (changeType == RecipeChangeType.Edited)
        {
            // No-op guard: if the new snapshot matches the previous one
            // verbatim, don't pollute history with a meaningless row.
            if (previous is not null && string.Equals(previous.SnapshotJson, snapshotJson, StringComparison.Ordinal))
                return;

            if (previous is not null)
            {
                var previousSnapshot = JsonSerializer.Deserialize<RecipeSnapshot>(
                    previous.SnapshotJson, SnapshotJsonOptions);
                diffSummary = previousSnapshot is null
                    ? null
                    : BuildEditedDiffSummary(previousSnapshot, snapshot);
            }
        }
        else if (changeType == RecipeChangeType.Forked)
        {
            diffSummary = string.IsNullOrWhiteSpace(sourceDescription)
                ? "Rezept geforkt"
                : sourceDescription;
        }
        else if (changeType == RecipeChangeType.Created && previous is null)
        {
            diffSummary = "Rezept angelegt";
        }

        var revision = new RecipeRevision(
            recipeId: recipeId,
            changedByUserId: changedByUserId,
            changeType: changeType,
            snapshotJson: snapshotJson,
            diffSummary: diffSummary,
            createdAt: now);

        db.RecipeRevisions.Add(revision);

        // Prune-on-insert: remove oldest beyond the retention window. We
        // already loaded existingRevisions above (sans the new row) — once
        // the insert lands the total becomes existingRevisions.Count + 1,
        // so drop everything beyond (RetainCount - 1) existing rows.
        var existingOrdered = existingRevisions
            .OrderByDescending(r => r.CreatedAt)
            .ToList();
        var keepFromExisting = Math.Max(0, RetainCount - 1);
        var toRemove = existingOrdered.Skip(keepFromExisting).ToList();
        if (toRemove.Count > 0)
        {
            // Already tracked via the load above — Remove transitions them
            // to the Deleted state; SaveChangesAsync issues the INSERT
            // and the DELETEs in a single transaction.
            db.RecipeRevisions.RemoveRange(toRemove);
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<RecipeRevision>> GetLastAsync(
        Guid recipeId,
        int take = 5,
        CancellationToken ct = default)
    {
        if (take <= 0) return Array.Empty<RecipeRevision>();
        // Materialize then sort: SQLite cannot ORDER BY DateTimeOffset
        // server-side, and the per-recipe set is bounded at 5 anyway.
        var rows = await db.RecipeRevisions
            .Where(r => r.RecipeId == recipeId)
            .AsNoTracking()
            .ToListAsync(ct);
        return rows
            .OrderByDescending(r => r.CreatedAt)
            .Take(take)
            .ToList();
    }

    // ── Snapshot DTOs ──────────────────────────────────────────────────

    /// <summary>
    /// Serializable snapshot of a recipe's content. Property names are
    /// part of the on-disk wire contract; matches the TypeScript
    /// <c>RecipeSnapshot</c> type in <c>@familien-kochbuch/shared</c>.
    /// </summary>
    public sealed class RecipeSnapshot
    {
        public string Title { get; set; } = string.Empty;
        public string? Description { get; set; }
        public int DefaultServings { get; set; }
        public int? PrepTimeMinutes { get; set; }
        public int Difficulty { get; set; }
        public string? SourceUrl { get; set; }
        public List<IngredientSnapshot> Ingredients { get; set; } = new();
        public List<StepSnapshot> Steps { get; set; } = new();
        public List<Guid> TagIds { get; set; } = new();
    }

    public sealed class IngredientSnapshot
    {
        public int Position { get; set; }
        public decimal? Quantity { get; set; }
        public string Unit { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string? Note { get; set; }
        public bool Scalable { get; set; }
    }

    public sealed class StepSnapshot
    {
        public int Position { get; set; }
        public string Content { get; set; } = string.Empty;
    }

    // ── Snapshot construction ──────────────────────────────────────────

    private static RecipeSnapshot BuildSnapshot(Recipe recipe) => new()
    {
        Title = recipe.Title,
        Description = recipe.Description,
        DefaultServings = recipe.DefaultServings,
        PrepTimeMinutes = recipe.PrepTimeMinutes,
        Difficulty = recipe.Difficulty,
        SourceUrl = recipe.SourceUrl,
        Ingredients = recipe.Ingredients
            .OrderBy(i => i.Position)
            .Select(i => new IngredientSnapshot
            {
                Position = i.Position,
                Quantity = i.Quantity,
                Unit = i.Unit,
                Name = i.Name,
                Note = i.Note,
                Scalable = i.Scalable,
            })
            .ToList(),
        Steps = recipe.Steps
            .OrderBy(s => s.Position)
            .Select(s => new StepSnapshot
            {
                Position = s.Position,
                Content = s.Content,
            })
            .ToList(),
        TagIds = recipe.RecipeTags
            .Select(rt => rt.TagId)
            .OrderBy(id => id)
            .ToList(),
    };

    // ── Diff summary computation ───────────────────────────────────────

    /// <summary>
    /// Builds a human-readable German one-liner that calls out top-level
    /// metadata changes plus add/remove counts on ingredients and steps.
    /// Pure function — no DB I/O — so it's directly testable on its own.
    /// </summary>
    public static string? BuildEditedDiffSummary(RecipeSnapshot previous, RecipeSnapshot current)
    {
        var parts = new List<string>();

        if (!string.Equals(previous.Title, current.Title, StringComparison.Ordinal))
            parts.Add("Titel geändert");

        if (!string.Equals(previous.Description, current.Description, StringComparison.Ordinal))
            parts.Add("Beschreibung geändert");

        if (previous.DefaultServings != current.DefaultServings)
            parts.Add("Standard-Portionen geändert");

        if (previous.PrepTimeMinutes != current.PrepTimeMinutes)
            parts.Add("Zubereitungszeit geändert");

        if (previous.Difficulty != current.Difficulty)
            parts.Add("Schwierigkeit geändert");

        if (!string.Equals(previous.SourceUrl, current.SourceUrl, StringComparison.Ordinal))
            parts.Add("Quelle geändert");

        AppendListChanges(parts, "Zutat", "Zutaten",
            previous.Ingredients.Count, current.Ingredients.Count,
            CountIngredientModifications(previous.Ingredients, current.Ingredients));

        AppendListChanges(parts, "Schritt", "Schritte",
            previous.Steps.Count, current.Steps.Count,
            CountStepModifications(previous.Steps, current.Steps));

        AppendListChanges(parts, "Tag", "Tags",
            previous.TagIds.Count, current.TagIds.Count,
            modified: 0);

        if (parts.Count == 0)
            return null;
        return string.Join(", ", parts);
    }

    private static void AppendListChanges(
        List<string> parts,
        string singular,
        string plural,
        int previousCount,
        int currentCount,
        int modified)
    {
        if (currentCount > previousCount)
        {
            var added = currentCount - previousCount;
            parts.Add($"{added} {(added == 1 ? singular : plural)} hinzugefügt");
        }
        else if (currentCount < previousCount)
        {
            var removed = previousCount - currentCount;
            parts.Add($"{removed} {(removed == 1 ? singular : plural)} entfernt");
        }

        if (modified > 0)
        {
            parts.Add($"{modified} {(modified == 1 ? singular : plural)} geändert");
        }
    }

    private static int CountIngredientModifications(
        IReadOnlyList<IngredientSnapshot> previous,
        IReadOnlyList<IngredientSnapshot> current)
    {
        var modified = 0;
        var min = Math.Min(previous.Count, current.Count);
        for (var i = 0; i < min; i++)
        {
            var p = previous[i];
            var c = current[i];
            if (p.Quantity != c.Quantity ||
                !string.Equals(p.Unit, c.Unit, StringComparison.Ordinal) ||
                !string.Equals(p.Name, c.Name, StringComparison.Ordinal) ||
                !string.Equals(p.Note, c.Note, StringComparison.Ordinal) ||
                p.Scalable != c.Scalable)
            {
                modified++;
            }
        }
        return modified;
    }

    private static int CountStepModifications(
        IReadOnlyList<StepSnapshot> previous,
        IReadOnlyList<StepSnapshot> current)
    {
        var modified = 0;
        var min = Math.Min(previous.Count, current.Count);
        for (var i = 0; i < min; i++)
        {
            if (!string.Equals(previous[i].Content, current[i].Content, StringComparison.Ordinal))
                modified++;
        }
        return modified;
    }
}
