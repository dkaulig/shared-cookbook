using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// PF2 admin endpoint: <c>GET /api/admin/ai-usage</c>. Aggregates token
/// spend across both <see cref="RecipeImport"/> rows (where the usage
/// columns are non-null) and the <see cref="ChatUsageLog"/> table, and
/// returns grand totals plus a grouping breakdown.
///
/// Query params:
/// <list type="bullet">
/// <item><c>from</c> — optional inclusive lower bound on CreatedAt.</item>
/// <item><c>to</c> — optional inclusive upper bound on CreatedAt.</item>
/// <item><c>groupBy</c> — one of <c>user</c>, <c>model</c>, <c>day</c>.
/// Defaults to <c>model</c> so a bare call gives the most actionable
/// breakdown (which deployment is burning tokens).</item>
/// </list>
///
/// Auth: admin-only (site <see cref="UserRole.Admin"/>). Anonymous
/// callers get 401; non-admin authenticated callers get 403. The
/// authorization policy is enforced manually in the handler because
/// the JWT bearer pipeline only covers the authenticated vs.
/// anonymous split — role claims are string-compared.
/// </summary>
public static class AdminAiUsageEndpoints
{
    public enum GroupBy
    {
        User = 0,
        Model = 1,
        Day = 2,
    }

    /// <summary>Grand-totals + grouped breakdown payload.</summary>
    public sealed record AiUsageSummaryDto(
        long TotalPromptTokens,
        long TotalCompletionTokens,
        long TotalCachedTokens,
        decimal TotalUsd,
        decimal TotalEur,
        string GroupBy,
        AiUsageGroupedRowDto[] Groups);

    /// <summary>One grouping row. <c>Key</c> is the user display name,
    /// model deployment, or ISO-8601 day as appropriate.</summary>
    public sealed record AiUsageGroupedRowDto(
        string Key,
        long PromptTokens,
        long CompletionTokens,
        long CachedTokens,
        decimal Usd,
        decimal Eur);

    public static void MapAdminAiUsageEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/admin/ai-usage").WithTags("Admin");
        group.MapGet("/", GetAsync).RequireAuthorization();
    }

    private static async Task<IResult> GetAsync(
        HttpContext ctx,
        AppDbContext db,
        AiPricingService pricing,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? groupBy,
        CancellationToken ct)
    {
        if (!ctx.User.IsAdmin())
            return Results.Forbid();

        var grouping = ParseGroupBy(groupBy);

        // Postgres translates the full WHERE server-side; SQLite can't
        // translate DateTimeOffset comparisons so for the test path we
        // filter in memory instead. Same pattern as
        // <see cref="Jobs.SweepAbandonedStagedPhotosJob"/>.
        var providerName = db.Database.ProviderName ?? string.Empty;
        var isSqlite = providerName.Contains("Sqlite", StringComparison.OrdinalIgnoreCase);

        // ── RecipeImport rows ────────────────────────────────────
        // Only rows where RecordUsage actually fired. Status filter
        // keeps in-flight imports (Running) out of the aggregate.
        var importsQuery = db.RecipeImports
            .Where(i => i.PromptTokens != null && i.ModelDeployment != null);
        if (!isSqlite)
        {
            if (from.HasValue)
                importsQuery = importsQuery.Where(i => i.CreatedAt >= from.Value);
            if (to.HasValue)
                importsQuery = importsQuery.Where(i => i.CreatedAt <= to.Value);
        }

        var importsRaw = await importsQuery
            .Select(i => new UsageRow(
                i.UserId,
                i.ModelDeployment!,
                i.PromptTokens!.Value,
                i.CompletionTokens ?? 0,
                i.CachedPromptTokens ?? 0,
                i.CreatedAt))
            .ToListAsync(ct);
        var imports = ApplyDateFilterInMemory(importsRaw, from, to, applyFilter: isSqlite);

        // ── ChatUsageLog rows ────────────────────────────────────
        var chatQuery = db.ChatUsageLogs.AsQueryable();
        if (!isSqlite)
        {
            if (from.HasValue)
                chatQuery = chatQuery.Where(c => c.CreatedAt >= from.Value);
            if (to.HasValue)
                chatQuery = chatQuery.Where(c => c.CreatedAt <= to.Value);
        }

        var chatLogsRaw = await chatQuery
            .Select(c => new UsageRow(
                c.UserId,
                c.ModelDeployment,
                c.PromptTokens,
                c.CompletionTokens,
                c.CachedPromptTokens,
                c.CreatedAt))
            .ToListAsync(ct);
        var chatLogs = ApplyDateFilterInMemory(chatLogsRaw, from, to, applyFilter: isSqlite);

        var allRows = imports.Concat(chatLogs).ToList();

        // ── Grand totals ─────────────────────────────────────────
        long totalPrompt = 0, totalCompletion = 0, totalCached = 0;
        decimal totalUsd = 0m;
        foreach (var row in allRows)
        {
            totalPrompt += row.PromptTokens;
            totalCompletion += row.CompletionTokens;
            totalCached += row.CachedPromptTokens;
            totalUsd += pricing.CalculateUsd(
                row.Model, row.PromptTokens, row.CachedPromptTokens, row.CompletionTokens);
        }

        // ── Grouped rows ─────────────────────────────────────────
        var userDisplayNames = grouping == GroupBy.User
            ? await db.Users.ToDictionaryAsync(u => u.Id, u => u.DisplayName ?? u.Id.ToString("D"), ct)
            : new Dictionary<Guid, string>();

        var groups = grouping switch
        {
            GroupBy.User => GroupByUser(allRows, pricing, userDisplayNames),
            GroupBy.Model => GroupByModel(allRows, pricing),
            GroupBy.Day => GroupByDay(allRows, pricing),
            _ => throw new InvalidOperationException("unreachable"),
        };

        return Results.Ok(new AiUsageSummaryDto(
            TotalPromptTokens: totalPrompt,
            TotalCompletionTokens: totalCompletion,
            TotalCachedTokens: totalCached,
            TotalUsd: totalUsd,
            TotalEur: pricing.ConvertToEur(totalUsd),
            GroupBy: grouping.ToString().ToLowerInvariant(),
            Groups: groups.ToArray()));
    }

    private static IEnumerable<AiUsageGroupedRowDto> GroupByUser(
        IEnumerable<UsageRow> rows,
        AiPricingService pricing,
        IReadOnlyDictionary<Guid, string> userDisplayNames) =>
        rows
            .GroupBy(r => r.UserId)
            .Select(g => BuildRow(
                key: userDisplayNames.TryGetValue(g.Key, out var name)
                    ? name
                    : g.Key.ToString("D"),
                rows: g,
                pricing: pricing))
            .OrderByDescending(r => r.Usd);

    private static IEnumerable<AiUsageGroupedRowDto> GroupByModel(
        IEnumerable<UsageRow> rows, AiPricingService pricing) =>
        rows
            .GroupBy(r => r.Model)
            .Select(g => BuildRow(key: g.Key, rows: g, pricing: pricing))
            .OrderByDescending(r => r.Usd);

    private static IEnumerable<AiUsageGroupedRowDto> GroupByDay(
        IEnumerable<UsageRow> rows, AiPricingService pricing) =>
        rows
            .GroupBy(r => r.CreatedAt.UtcDateTime.Date)
            .Select(g => BuildRow(
                key: g.Key.ToString("yyyy-MM-dd"),
                rows: g,
                pricing: pricing))
            .OrderBy(r => r.Key);

    private static AiUsageGroupedRowDto BuildRow(
        string key, IEnumerable<UsageRow> rows, AiPricingService pricing)
    {
        long prompt = 0, completion = 0, cached = 0;
        decimal usd = 0m;
        foreach (var r in rows)
        {
            prompt += r.PromptTokens;
            completion += r.CompletionTokens;
            cached += r.CachedPromptTokens;
            usd += pricing.CalculateUsd(
                r.Model, r.PromptTokens, r.CachedPromptTokens, r.CompletionTokens);
        }
        return new AiUsageGroupedRowDto(
            Key: key,
            PromptTokens: prompt,
            CompletionTokens: completion,
            CachedTokens: cached,
            Usd: usd,
            Eur: pricing.ConvertToEur(usd));
    }

    private static List<UsageRow> ApplyDateFilterInMemory(
        List<UsageRow> rows,
        DateTimeOffset? from,
        DateTimeOffset? to,
        bool applyFilter)
    {
        if (!applyFilter) return rows;
        var filtered = rows.AsEnumerable();
        if (from.HasValue) filtered = filtered.Where(r => r.CreatedAt >= from.Value);
        if (to.HasValue) filtered = filtered.Where(r => r.CreatedAt <= to.Value);
        return filtered.ToList();
    }

    private static GroupBy ParseGroupBy(string? raw) =>
        raw?.Trim().ToLowerInvariant() switch
        {
            null or "" or "model" => GroupBy.Model,
            "user" => GroupBy.User,
            "day" => GroupBy.Day,
            _ => GroupBy.Model,
        };

    /// <summary>Normalised row shape feeding the grouping helpers — one
    /// per LLM call, regardless of whether it came from
    /// <see cref="RecipeImport"/> or <see cref="ChatUsageLog"/>.</summary>
    private sealed record UsageRow(
        Guid UserId,
        string Model,
        int PromptTokens,
        int CompletionTokens,
        int CachedPromptTokens,
        DateTimeOffset CreatedAt);
}
