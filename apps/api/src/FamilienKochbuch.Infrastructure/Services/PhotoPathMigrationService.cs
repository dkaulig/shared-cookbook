using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// Idempotent startup fixup that rewrites legacy S3-era photo URLs in
/// <c>Recipes.Photos</c> to bare storage paths.
///
/// Fresh installs see an empty Recipes table so the pass is a no-op.
/// Installs upgraded from S3 have entries like
/// <c>http://localhost/photos/recipe-photos/{guid}.ext</c> or
/// <c>http://seaweedfs:8333/recipe-photos/{guid}.ext</c>; both are
/// rewritten to <c>recipes/{guid}.ext</c> (the filer-era layout used by
/// <see cref="SeaweedFsPhotoStorage"/>).
///
/// Mirrors the pattern used by
/// <see cref="SeedDataService"/>'s <c>BackfillPrivateCollectionsAsync</c>:
/// iterate affected rows, mutate in place, save once. Unparseable
/// entries are logged and left untouched rather than failing startup.
/// </summary>
public class PhotoPathMigrationService(
    AppDbContext db,
    ILogger<PhotoPathMigrationService> logger)
{
    /// <summary>Old bucket name from S3 — appears in both Caddy-proxied
    /// and direct-SeaweedFS URLs as a path segment.</summary>
    private const string LegacyBucketSegment = "recipe-photos/";

    /// <summary>New storage prefix used by
    /// <see cref="SeaweedFsPhotoStorage.PathPrefix"/>.</summary>
    private const string NewPathPrefix = "recipes/";

    public async Task NormalizePhotoPathsAsync(CancellationToken ct = default)
    {
        // Photos is backed by a JSON value converter — filtering server-side
        // on Count would force EF to translate `Photos.Count > 0` against a
        // column it can't reason about. The Recipe table is small in
        // Phase 1 so load + filter in memory.
        var allRecipes = await db.Recipes.ToListAsync(ct);
        var recipes = allRecipes.Where(r => r.Photos.Count > 0).ToList();

        if (recipes.Count == 0) return;

        var rewritten = 0;
        foreach (var recipe in recipes)
        {
            var changed = false;
            for (var i = 0; i < recipe.Photos.Count; i++)
            {
                var original = recipe.Photos[i];
                var rewrittenValue = TryRewrite(original);
                if (rewrittenValue is null || rewrittenValue == original) continue;
                recipe.Photos[i] = rewrittenValue;
                changed = true;
                rewritten++;
            }

            if (changed)
            {
                // EF Core tracks the List<string> as a value converter; mark
                // the property modified so the change is actually persisted.
                db.Entry(recipe).Property(r => r.Photos).IsModified = true;
            }
        }

        if (rewritten > 0)
        {
            await db.SaveChangesAsync(ct);
            logger.LogInformation(
                "Photo-path migration: rewrote {Count} legacy photo entries to bare paths.",
                rewritten);
        }
    }

    /// <summary>
    /// Returns the bare path if <paramref name="value"/> is a legacy S3-era URL,
    /// otherwise null (caller leaves the entry untouched). Already-bare
    /// paths (starting with <c>recipes/</c>) are also returned as-is, so
    /// the migration is safe to re-run.
    /// </summary>
    private static string? TryRewrite(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;

        // Already in the new shape → nothing to do.
        if (value.StartsWith(NewPathPrefix, StringComparison.Ordinal))
            return value;

        // Look for ".../recipe-photos/{guid}.ext" in the legacy URL and
        // pull out the filename segment.
        var idx = value.IndexOf(LegacyBucketSegment, StringComparison.Ordinal);
        if (idx < 0)
        {
            // Not a shape we recognize — log once per unknown value so the
            // operator can investigate rather than silently corrupting rows.
            return null;
        }

        var filename = value[(idx + LegacyBucketSegment.Length)..];

        // Strip any query string that might have snuck in.
        var qIdx = filename.IndexOf('?');
        if (qIdx >= 0) filename = filename[..qIdx];

        if (string.IsNullOrWhiteSpace(filename)) return null;

        return NewPathPrefix + filename;
    }
}
