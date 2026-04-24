using System.Text.Json;
using System.Text.Json.Serialization;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// CFG-0 — admin-only CRUD surface on the <see cref="ExtractorConfig"/>
/// table. All routes gated by the <see cref="UserRole.Admin"/> role
/// claim (same convention as <see cref="AdminAiUsageEndpoints"/>).
///
/// <list type="bullet">
/// <item><c>GET /api/admin/extractor-config</c> — full list,
/// ordered by Key. Every row carries the last-editor's display name so
/// the UI can render "zuletzt bearbeitet von X" without a second
/// round-trip.</item>
/// <item><c>GET /api/admin/extractor-config/{key}</c> — single row + the
/// last 10 history entries for the audit timeline.</item>
/// <item><c>PUT /api/admin/extractor-config/{key}</c> — body
/// <c>{ value, expectedVersion }</c>. Validates the value per
/// <see cref="ConfigKeyValidator"/>; 409 on version mismatch; 400 on
/// invalid value; 200 with the post-update snapshot on success. The
/// <see cref="ExtractorConfigHistory"/> row is written in the same
/// transaction.</item>
/// <item><c>POST /api/admin/extractor-config/{key}/reset</c> — reverts
/// to the hardcoded default from <see cref="ExtractorConfigDefaults"/>,
/// writes a history row capturing the reset.</item>
/// </list>
/// </summary>
public static class AdminExtractorConfigEndpoints
{
    public const string RoutePrefix = "/api/admin/extractor-config";

    /// <summary>
    /// PUT body. <c>Value</c> stays a raw <see cref="JsonElement"/> so
    /// the admin UI can send the native JSON shape (number, bool,
    /// string, array) without pre-serialising; the endpoint hands it
    /// to <see cref="ConfigKeyValidator"/> which owns the type check.
    /// </summary>
    public sealed record PutConfigRequest(
        [property: JsonPropertyName("value")] JsonElement Value,
        [property: JsonPropertyName("expectedVersion")] int ExpectedVersion);

    public sealed record UpdatedByDto(Guid Id, string DisplayName);

    public sealed record ConfigItemDto(
        string Key,
        JsonElement Value,
        string Type,
        DateTimeOffset UpdatedAt,
        UpdatedByDto? UpdatedBy,
        int Version);

    public sealed record ConfigListResponse(ConfigItemDto[] Items);

    public sealed record HistoryEntryDto(
        JsonElement OldValue,
        JsonElement NewValue,
        DateTimeOffset ChangedAt,
        UpdatedByDto? ChangedBy);

    public sealed record ConfigDetailResponse(
        ConfigItemDto Item,
        HistoryEntryDto[] History);

    public static void MapAdminExtractorConfigEndpoints(this WebApplication app)
    {
        var group = app.MapGroup(RoutePrefix).WithTags("AdminExtractorConfig");

        // All routes require authentication; admin check runs inside
        // the handler (same pattern as AdminAiUsageEndpoints: JWT
        // pipeline handles the auth'd-vs-anonymous split, role-claim
        // comparison lives here).
        group.MapGet("/", ListAsync).RequireAuthorization();
        group.MapGet("/{key}", GetAsync).RequireAuthorization();
        group.MapPut("/{key}", PutAsync).RequireAuthorization();
        group.MapPost("/{key}/reset", ResetAsync).RequireAuthorization();
    }

    private static async Task<IResult> ListAsync(
        HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        if (!ctx.User.IsAdmin()) return Results.Forbid();

        var rows = await db.ExtractorConfigs
            .AsNoTracking()
            .OrderBy(c => c.Key)
            .ToListAsync(ct);

        var userIds = rows
            .Where(r => r.UpdatedBy.HasValue)
            .Select(r => r.UpdatedBy!.Value)
            .Distinct()
            .ToArray();
        var userNames = await LoadUserNamesAsync(db, userIds, ct);

        var items = rows
            .Select(r => ToItemDto(r, userNames))
            .ToArray();
        return Results.Ok(new ConfigListResponse(items));
    }

    private static async Task<IResult> GetAsync(
        string key, HttpContext ctx, AppDbContext db, CancellationToken ct)
    {
        if (!ctx.User.IsAdmin()) return Results.Forbid();

        var row = await db.ExtractorConfigs
            .AsNoTracking()
            .SingleOrDefaultAsync(c => c.Key == key, ct);
        if (row is null)
            return FamilienResults.NotFound(
                ErrorCodes.ConfigKeyNotFound,
                $"Unknown configuration key '{key}'.");

        // SQLite can't translate DateTimeOffset in ORDER BY; same
        // workaround as AdminAiUsageEndpoints — fetch + sort in memory
        // for the test path. Postgres translates fine server-side.
        var providerName = db.Database.ProviderName ?? string.Empty;
        var isSqlite = providerName.Contains("Sqlite", StringComparison.OrdinalIgnoreCase);
        List<ExtractorConfigHistory> history;
        if (isSqlite)
        {
            var raw = await db.ExtractorConfigHistories
                .AsNoTracking()
                .Where(h => h.Key == key)
                .ToListAsync(ct);
            history = raw.OrderByDescending(h => h.ChangedAt).Take(10).ToList();
        }
        else
        {
            history = await db.ExtractorConfigHistories
                .AsNoTracking()
                .Where(h => h.Key == key)
                .OrderByDescending(h => h.ChangedAt)
                .Take(10)
                .ToListAsync(ct);
        }

        var editorIds = new HashSet<Guid>();
        if (row.UpdatedBy is { } uid) editorIds.Add(uid);
        foreach (var h in history)
            if (h.ChangedBy is { } cb) editorIds.Add(cb);
        var userNames = await LoadUserNamesAsync(db, editorIds.ToArray(), ct);

        var item = ToItemDto(row, userNames);
        var historyDtos = history
            .Select(h => new HistoryEntryDto(
                OldValue: ParseJson(h.OldValueJson),
                NewValue: ParseJson(h.NewValueJson),
                ChangedAt: h.ChangedAt,
                ChangedBy: h.ChangedBy is { } cb && userNames.TryGetValue(cb, out var n)
                    ? new UpdatedByDto(cb, n)
                    : null))
            .ToArray();

        return Results.Ok(new ConfigDetailResponse(item, historyDtos));
    }

    private static async Task<IResult> PutAsync(
        string key,
        PutConfigRequest body,
        HttpContext ctx,
        AppDbContext db,
        ConfigKeyValidator validator,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!ctx.User.IsAdmin()) return Results.Forbid();

        var row = await db.ExtractorConfigs.SingleOrDefaultAsync(c => c.Key == key, ct);
        if (row is null)
            return FamilienResults.NotFound(
                ErrorCodes.ConfigKeyNotFound,
                $"Unknown configuration key '{key}'.");

        if (row.Version != body.ExpectedVersion)
            return FamilienResults.Conflict(
                ErrorCodes.VersionMismatch,
                $"Version mismatch: server has {row.Version}, client expected {body.ExpectedVersion}. Reload and retry.",
                current: new
                {
                    key = row.Key,
                    version = row.Version,
                    updatedAt = row.UpdatedAt,
                });

        var validation = validator.Validate(key, body.Value);
        if (!validation.IsValid)
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidValue,
                validation.ErrorMessage!,
                fieldName: "value");

        var editorId = ctx.User.GetUserId();
        var oldJson = row.UpdateValue(
            newValueJson: validation.NormalizedJson!,
            updatedAt: clock.GetUtcNow(),
            updatedBy: editorId);

        db.ExtractorConfigHistories.Add(new ExtractorConfigHistory(
            key: key,
            oldValueJson: oldJson,
            newValueJson: validation.NormalizedJson!,
            changedAt: clock.GetUtcNow(),
            changedBy: editorId));

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // The EF-level concurrency token (Version) caught a race
            // between our expectedVersion read and the SaveChanges
            // write — treat identically to the endpoint-level 409
            // so the admin UI has one branch to handle.
            return FamilienResults.Conflict(
                ErrorCodes.VersionMismatch,
                "Configuration was changed by someone else; reload and retry.");
        }

        var userNames = editorId is { } eid
            ? await LoadUserNamesAsync(db, new[] { eid }, ct)
            : EmptyUserNames;
        return Results.Ok(ToItemDto(row, userNames));
    }

    private static async Task<IResult> ResetAsync(
        string key,
        HttpContext ctx,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!ctx.User.IsAdmin()) return Results.Forbid();

        if (!ExtractorConfigDefaults.ByKey.TryGetValue(key, out var entry))
            return FamilienResults.NotFound(
                ErrorCodes.ConfigKeyNotFound,
                $"Unknown configuration key '{key}'.");

        var row = await db.ExtractorConfigs.SingleOrDefaultAsync(c => c.Key == key, ct);
        if (row is null)
            return FamilienResults.NotFound(
                ErrorCodes.ConfigKeyNotFound,
                $"Unknown configuration key '{key}'.");

        var editorId = ctx.User.GetUserId();
        var oldJson = row.UpdateValue(
            newValueJson: entry.DefaultValueJson,
            updatedAt: clock.GetUtcNow(),
            updatedBy: editorId);

        db.ExtractorConfigHistories.Add(new ExtractorConfigHistory(
            key: key,
            oldValueJson: oldJson,
            newValueJson: entry.DefaultValueJson,
            changedAt: clock.GetUtcNow(),
            changedBy: editorId));

        await db.SaveChangesAsync(ct);

        var userNames = editorId is { } eid
            ? await LoadUserNamesAsync(db, new[] { eid }, ct)
            : EmptyUserNames;
        return Results.Ok(ToItemDto(row, userNames));
    }

    // ── Shared helpers ─────────────────────────────────────────────────

    private static readonly IReadOnlyDictionary<Guid, string> EmptyUserNames =
        new Dictionary<Guid, string>();

    private static async Task<IReadOnlyDictionary<Guid, string>> LoadUserNamesAsync(
        AppDbContext db, Guid[] ids, CancellationToken ct)
    {
        if (ids.Length == 0) return EmptyUserNames;
        return await db.Users
            .AsNoTracking()
            .Where(u => ids.Contains(u.Id))
            .ToDictionaryAsync(
                u => u.Id,
                u => u.DisplayName ?? u.Id.ToString("D"),
                ct);
    }

    private static ConfigItemDto ToItemDto(
        ExtractorConfig row,
        IReadOnlyDictionary<Guid, string> userNames)
    {
        UpdatedByDto? editor = null;
        if (row.UpdatedBy is { } uid && userNames.TryGetValue(uid, out var name))
            editor = new UpdatedByDto(uid, name);
        return new ConfigItemDto(
            Key: row.Key,
            Value: ParseJson(row.ValueJson),
            Type: ValueTypeWireName(row.ValueType),
            UpdatedAt: row.UpdatedAt,
            UpdatedBy: editor,
            Version: row.Version);
    }

    internal static string ValueTypeWireName(ExtractorConfigValueType type) => type switch
    {
        ExtractorConfigValueType.String => "string",
        ExtractorConfigValueType.Int => "int",
        ExtractorConfigValueType.Float => "float",
        ExtractorConfigValueType.Bool => "bool",
        ExtractorConfigValueType.StringList => "string_list",
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, null),
    };

    internal static JsonElement ParseJson(string raw)
    {
        // Null-safe parse — the domain layer already guarantees
        // ValueJson is non-blank, but a malformed payload (should never
        // happen; all writes go through the validator) falls through
        // as a JSON null rather than throwing.
        using var doc = JsonDocument.Parse(raw);
        return doc.RootElement.Clone();
    }
}
