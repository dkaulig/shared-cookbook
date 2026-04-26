using System.Text.Json;
using System.Text.Json.Serialization;
using SharedCookbook.Api.Services;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace SharedCookbook.Api.Endpoints;

/// <summary>
/// CFG-0 — internal-only read surface on the extractor-config table,
/// consumed by the Python extractor's TTL-cached config loader
/// (CFG-1). No JWT required: the
/// <see cref="InternalOnlyMiddleware"/> + Caddy's <c>@internal</c>
/// matcher gate the trust boundary upstream.
///
/// <list type="bullet">
/// <item><c>GET /api/internal/extractor-config</c> — same DTO as the
/// admin list endpoint. Python polls this every 60 s to refresh its
/// in-memory cache; a fetch failure keeps the stale cache and logs a
/// warning (the Python side owns that fallback logic).</item>
/// <item><c>POST /api/internal/extractor-config/refresh</c> — no-op
/// placeholder, returns 204 immediately. The E2E gate calls this to
/// signal the Python side to refresh without waiting out the 60 s TTL;
/// the Python cache polls this endpoint's timestamp header (and the
/// list endpoint on TTL) rather than receiving a push. This stub
/// exists so the frontend / E2E test can reach a 204 without a
/// dependency on Python being up.</item>
/// <item><c>POST /api/internal/extractor-config/seed-prompts</c> —
/// CFG-1b. Idempotent placeholder-replace: Python posts the three real
/// system prompts (<c>SYSTEM_PROMPT_DE</c>, the chat base prompt, the
/// vision prompt) at startup. For each row, if the current value still
/// matches the literal <c>"PLACEHOLDER_*_PROMPT"</c> seed (or any
/// string starting with <c>PLACEHOLDER_</c>) we overwrite + bump
/// Version + stamp UpdatedAt; once an admin has edited the row the
/// endpoint refuses to clobber it ("skipped"). The response body is a
/// per-key outcome map so Python can log "wrote 2/3, 1 already
/// admin-edited".</item>
/// </list>
/// </summary>
public static class InternalExtractorConfigEndpoints
{
    public const string RoutePrefix = "/api/internal/extractor-config";

    /// <summary>
    /// Hard cap on a single seed-prompt body field. 16 KB comfortably
    /// covers the real DE prompts (~3 KB each today) while bounding the
    /// worst case so an attacker who somehow reaches the internal
    /// trust boundary can't inflate a row to multi-MB. Lower than the
    /// 20_000-char admin cap on purpose: the seed path is a static
    /// startup write, not a free-form admin edit, and the tighter
    /// budget catches accidental copy-paste explosions early.
    /// </summary>
    public const int MaxSeedPromptLength = 16 * 1024;

    /// <summary>
    /// Minimum length of a seeded prompt. A blank / whitespace-only
    /// payload would otherwise replace the placeholder with an empty
    /// string and the admin UI would render an empty textarea — same
    /// regression class as the original placeholder bug. Mirrors
    /// <c>ConfigKeyValidator.MinPromptChars</c> so admin edits + Python
    /// seeds enforce the same floor.
    /// </summary>
    public const int MinSeedPromptLength = 100;

    public sealed record InternalConfigItemDto(
        string Key,
        JsonElement Value,
        string Type,
        DateTimeOffset UpdatedAt,
        int Version);

    public sealed record InternalConfigListResponse(InternalConfigItemDto[] Items);

    /// <summary>
    /// Body for <c>POST /seed-prompts</c>. Three required strings — one
    /// per system-prompt key. Python posts the full DE prompt text at
    /// startup; the endpoint's idempotent check decides whether to
    /// write or skip.
    /// </summary>
    public sealed record SeedPromptsRequest(
        [property: JsonPropertyName("structured")] string Structured,
        [property: JsonPropertyName("chat")] string Chat,
        [property: JsonPropertyName("vision")] string Vision);

    public static void MapInternalExtractorConfigEndpoints(this WebApplication app)
    {
        // Deliberately NO RequireAuthorization: the route is internal-
        // trust-boundary only. Auth is enforced upstream by Caddy's
        // @internal matcher + InternalOnlyMiddleware.
        var group = app.MapGroup(RoutePrefix).WithTags("InternalExtractorConfig");
        group.MapGet("/", ListAsync);
        group.MapPost("/refresh", RefreshAsync);
        group.MapPost("/seed-prompts", SeedPromptsAsync);
    }

    private static async Task<IResult> ListAsync(
        AppDbContext db, CancellationToken ct)
    {
        var rows = await db.ExtractorConfigs
            .AsNoTracking()
            .OrderBy(c => c.Key)
            .ToListAsync(ct);

        var items = rows.Select(r => new InternalConfigItemDto(
            Key: r.Key,
            Value: AdminExtractorConfigEndpoints.ParseJson(r.ValueJson),
            Type: AdminExtractorConfigEndpoints.ValueTypeWireName(r.ValueType),
            UpdatedAt: r.UpdatedAt,
            Version: r.Version)).ToArray();

        return Results.Ok(new InternalConfigListResponse(items));
    }

    private static IResult RefreshAsync()
    {
        // No-op placeholder. The actual cache lives inside the Python
        // extractor process; this endpoint exists so the E2E gate can
        // synchronously signal "next GET will be a hit" without
        // waiting for the TTL. Returns 204 so the caller's contract
        // stays simple (success == OK, anything else == surface).
        return Results.NoContent();
    }

    /// <summary>
    /// Three system-prompt keys this endpoint operates on. Hard-coded
    /// rather than enum-derived so a future addition to
    /// <see cref="ExtractorConfigDefaults"/> doesn't accidentally widen
    /// the surface — this endpoint is purposely scoped to "the three
    /// prompt rows that ship as PLACEHOLDER_*".
    /// </summary>
    private const string StructuredKey = "llm.structured.system_prompt";
    private const string ChatKey = "llm.chat.system_prompt";
    private const string VisionKey = "llm.vision.system_prompt";

    private static async Task<IResult> SeedPromptsAsync(
        SeedPromptsRequest body,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        // Length bounds — upper cap prevents row-inflation; lower
        // floor blocks blank/whitespace payloads from masquerading as
        // a "real" prompt (an empty textarea in the admin UI would
        // recreate the same regression class as the original
        // placeholder bug). Returned as ErrorResponse so the (Python)
        // caller can log a structured failure, not just "non-2xx".
        var bounds = LengthGuard(body);
        if (bounds is not null)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidValue,
                bounds.Value.Message,
                fieldName: bounds.Value.Field);
        }

        var pairs = new[]
        {
            (Field: "structured", Key: StructuredKey, Value: body.Structured),
            (Field: "chat",       Key: ChatKey,       Value: body.Chat),
            (Field: "vision",     Key: VisionKey,     Value: body.Vision),
        };

        var summary = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (field, key, value) in pairs)
        {
            var row = await db.ExtractorConfigs.SingleOrDefaultAsync(c => c.Key == key, ct);
            if (row is null)
            {
                // Row missing entirely (fresh DB, seed migration didn't
                // run yet, or someone deleted the registry) — log + skip
                // rather than throwing. Python retries every TTL anyway.
                summary[field] = "skipped";
                continue;
            }

            if (!IsPlaceholder(row.ValueJson))
            {
                summary[field] = "skipped";
                continue;
            }

            // The value column stores JSON. Wrap the raw string in
            // JsonSerializer so quotes / backslashes / unicode escape
            // correctly — same shape ConfigKeyValidator produces for
            // a string-typed admin PUT.
            var newJson = JsonSerializer.Serialize(value);
            var oldJson = row.UpdateValue(
                newValueJson: newJson,
                updatedAt: clock.GetUtcNow(),
                updatedBy: null);

            db.ExtractorConfigHistories.Add(new ExtractorConfigHistory(
                key: key,
                oldValueJson: oldJson,
                newValueJson: newJson,
                changedAt: clock.GetUtcNow(),
                changedBy: null));

            summary[field] = "written";
        }

        await db.SaveChangesAsync(ct);
        return Results.Ok(summary);
    }

    /// <summary>
    /// True when the JSON-encoded string still carries one of the
    /// <c>PLACEHOLDER_*</c> seeds (or any future placeholder we want to
    /// treat as "not yet edited"). Defensive about both bare + JSON-
    /// quoted forms because the on-disk shape is JSON
    /// (<c>"\"PLACEHOLDER_STRUCTURED_PROMPT\""</c>).
    /// </summary>
    private static bool IsPlaceholder(string valueJson)
    {
        if (string.IsNullOrEmpty(valueJson)) return false;
        // Cheap text contains-check is sufficient: the prompt rows are
        // always JSON-encoded strings, so PLACEHOLDER_ inside the JSON
        // payload can only come from our own seed.
        return valueJson.Contains("PLACEHOLDER_", StringComparison.Ordinal);
    }

    private static (string Field, string Message)? LengthGuard(SeedPromptsRequest body)
    {
        return CheckOne("structured", body.Structured)
            ?? CheckOne("chat", body.Chat)
            ?? CheckOne("vision", body.Vision);

        static (string, string)? CheckOne(string field, string? value)
        {
            // Trim before measuring so a payload of pure whitespace
            // ("   ") doesn't sneak past the floor and clobber a
            // placeholder with "   ".
            var trimmed = (value ?? string.Empty).Trim();
            if (trimmed.Length < MinSeedPromptLength)
            {
                return (
                    field,
                    $"Prompt for '{field}' must be at least {MinSeedPromptLength} characters.");
            }
            if (trimmed.Length > MaxSeedPromptLength)
            {
                return (
                    field,
                    $"Prompt for '{field}' exceeds the {MaxSeedPromptLength}-byte cap.");
            }
            return null;
        }
    }
}
