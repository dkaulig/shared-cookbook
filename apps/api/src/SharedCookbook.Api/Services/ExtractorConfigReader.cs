using System.Text.Json;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace SharedCookbook.Api.Services;

/// <summary>
/// CFG-3 — read-only helper the .NET-side callers (<see cref="CandidateAttacher"/>,
/// <see cref="SharedCookbook.Api.Endpoints.ChatEndpoints"/>) use to
/// check an <c>ExtractorConfig</c> feature-flag row without reaching
/// into EF directly. The write-path surface (admin PUT / reset +
/// validation) stays owned by CFG-0's <c>AdminExtractorConfigEndpoints</c>
/// / <c>ConfigKeyValidator</c> — this reader is deliberately a
/// one-method affordance so a hot kill-switch check at a callsite
/// stays a single line.
///
/// <para>
/// Intentionally not cached: the two callsites that read these flags
/// today fire at most once per user-initiated action (one recipe import,
/// one chat-turn). A single <c>SELECT</c> on a small-row primary-key
/// table is sub-millisecond against Postgres; adding a
/// <c>MemoryCache</c> + TTL here would trade that speed for a window
/// where a freshly-toggled admin flag keeps serving stale reads.
/// CFG-1's Python loader already takes the TTL tradeoff for the hot
/// extractor path; the .NET side doesn't need it.
/// </para>
///
/// <para>
/// Fallback semantics mirror the seed defaults. If the row is missing
/// (brand-new DB before CFG-0's migration ran, or a caller asking about
/// a key that was never seeded), or the stored <c>ValueJson</c> doesn't
/// parse as a JSON bool, the reader returns the <paramref name="defaultValue"/>
/// passed by the caller. The caller picks the safe default per flag —
/// today every feature-flag defaults to <c>true</c>, matching the
/// seed in <c>ExtractorConfigDefaults</c>.
/// </para>
/// </summary>
public interface IExtractorConfigReader
{
    /// <summary>
    /// Reads the named feature flag row from the extractor-config table
    /// and parses its <c>ValueJson</c> as a JSON boolean. Returns
    /// <paramref name="defaultValue"/> when the row is missing or the
    /// stored payload isn't a parseable <c>true</c> / <c>false</c>.
    /// </summary>
    /// <param name="key">Dotted config key, e.g. <c>feature.chat_enabled</c>.</param>
    /// <param name="defaultValue">Fallback when the row is missing or
    /// the value can't be parsed as a bool. Should match the seeded
    /// default for the key so a brand-new DB and a healthy DB behave
    /// identically.</param>
    Task<bool> GetFeatureFlagAsync(string key, bool defaultValue, CancellationToken ct);

    /// <summary>
    /// Reads the named row and parses its <c>ValueJson</c> as a JSON
    /// integer. Returns <paramref name="defaultValue"/> when the row is
    /// missing or the stored payload isn't a parseable Int32. Used by
    /// the chat-client max-completion-tokens settings adapter so admin
    /// overrides on <c>llm.chat.max_completion_tokens</c> take effect on
    /// the very next chat request.
    /// </summary>
    /// <param name="key">Dotted config key, e.g.
    /// <c>llm.chat.max_completion_tokens</c>.</param>
    /// <param name="defaultValue">Fallback when the row is missing or the
    /// value can't be parsed. Should match the seeded default so a
    /// brand-new DB and a healthy DB behave identically.</param>
    Task<int> GetIntAsync(string key, int defaultValue, CancellationToken ct);
}

/// <inheritdoc />
public sealed class ExtractorConfigReader : IExtractorConfigReader
{
    private readonly AppDbContext _db;
    private readonly ILogger<ExtractorConfigReader> _logger;

    public ExtractorConfigReader(AppDbContext db, ILogger<ExtractorConfigReader> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<bool> GetFeatureFlagAsync(
        string key, bool defaultValue, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("Key must not be blank.", nameof(key));

        // PK lookup + projection: EF translates this to a single SELECT
        // of one column by primary key. AsNoTracking because the reader
        // never mutates the row and a tracked entity would waste a
        // DbContext ChangeTracker slot on every call.
        var valueJson = await _db.ExtractorConfigs
            .AsNoTracking()
            .Where(c => c.Key == key)
            .Select(c => c.ValueJson)
            .FirstOrDefaultAsync(ct);

        if (valueJson is null)
        {
            // Row missing — brand-new DB, or key was never seeded. Fall
            // back to the caller-supplied default; the caller matches
            // it to the seed so behaviour converges once the migration
            // or seeder runs.
            return defaultValue;
        }

        try
        {
            using var doc = JsonDocument.Parse(valueJson);
            if (doc.RootElement.ValueKind == JsonValueKind.True) return true;
            if (doc.RootElement.ValueKind == JsonValueKind.False) return false;
        }
        catch (JsonException)
        {
            // fall through to the malformed-value branch below.
        }

        _logger.LogWarning(
            "ExtractorConfig row '{Key}' has non-bool ValueJson '{ValueJson}'; falling back to {Default}.",
            key, valueJson, defaultValue);
        return defaultValue;
    }

    public async Task<int> GetIntAsync(
        string key, int defaultValue, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("Key must not be blank.", nameof(key));

        var valueJson = await _db.ExtractorConfigs
            .AsNoTracking()
            .Where(c => c.Key == key)
            .Select(c => c.ValueJson)
            .FirstOrDefaultAsync(ct);

        if (valueJson is null) return defaultValue;

        try
        {
            using var doc = JsonDocument.Parse(valueJson);
            if (doc.RootElement.ValueKind == JsonValueKind.Number
                && doc.RootElement.TryGetInt32(out var n))
            {
                return n;
            }
        }
        catch (JsonException)
        {
            // fall through to the malformed-value branch below.
        }

        _logger.LogWarning(
            "ExtractorConfig row '{Key}' has non-int ValueJson '{ValueJson}'; falling back to {Default}.",
            key, valueJson, defaultValue);
        return defaultValue;
    }
}
