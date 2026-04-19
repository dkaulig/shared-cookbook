using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.MealPlanning;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints.MealPlanning;

/// <summary>
/// P3-1 meal plan CRUD endpoints. All routes require authentication;
/// authorization is per-operation (caller must be a member of the
/// owning group). Error payload shape matches the rest of the API:
/// <c>{ "code": "...", "message": "..." }</c>.
///
/// PATCH uses JSON Merge Patch semantics via a <see cref="JsonElement"/>-
/// backed DTO: a field being absent from the body leaves the slot
/// untouched, a <c>null</c> value clears it (for nullable fields like
/// <c>recipeId</c>, <c>label</c>, <c>parentSlotId</c>), and a present
/// value updates it.
/// </summary>
public static class MealPlanEndpoints
{
    // ── Request / response DTOs ─────────────────────────────────────

    public record CreateMealPlanRequest(DateOnly WeekStart);

    public record AddSlotRequest(
        Guid? RecipeId,
        string? Label,
        DateOnly Date,
        MealSlot Meal,
        int Servings,
        int? SortOrder = null,
        Guid? ParentSlotId = null);

    /// <summary>
    /// Copy-from request body. <see cref="SourceWeekStart"/> is also in
    /// the route — the body is kept empty/optional so the route alone
    /// is authoritative, but the record exists for content-type
    /// negotiation + future expansion.
    /// </summary>
    public record CopyFromRequest();

    public record MealPlanSlotDto(
        Guid Id,
        Guid MealPlanId,
        Guid? RecipeId,
        string? Label,
        DateOnly Date,
        MealSlot Meal,
        int Servings,
        int SortOrder,
        bool IsCooked,
        Guid? ParentSlotId,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    public record MealPlanDto(
        Guid Id,
        Guid GroupId,
        DateOnly WeekStart,
        int Version,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        MealPlanSlotDto[] Slots);

    // ── Endpoint wiring ─────────────────────────────────────────────

    public static void MapMealPlanEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/groups/{groupId:guid}/mealplans")
            .WithTags("MealPlanning")
            .RequireAuthorization();
        group.MapGet("/{weekStart}", GetMealPlanAsync);
        group.MapPost("/", CreateMealPlanAsync);

        var plan = app.MapGroup("/api/mealplans/{planId:guid}")
            .WithTags("MealPlanning")
            .RequireAuthorization();
        plan.MapPost("/slots", AddSlotAsync);
        plan.MapPatch("/slots/{slotId:guid}", PatchSlotAsync);
        plan.MapDelete("/slots/{slotId:guid}", DeleteSlotAsync);
        plan.MapPost("/copy-from/{sourceWeekStart}", CopyFromAsync);
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

    /// <summary>
    /// Parses a date string from the URL segment. Only the ISO
    /// <c>yyyy-MM-dd</c> form is accepted so the wire format is
    /// unambiguous — no culture-sensitive fallback.
    /// </summary>
    private static bool TryParseIsoDate(string s, out DateOnly date) =>
        DateOnly.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out date);

    private static bool IsMonday(DateOnly d) => d.DayOfWeek == DayOfWeek.Monday;

    private static MealPlanSlotDto ToDto(MealPlanSlot s) => new(
        s.Id,
        s.MealPlanId,
        s.RecipeId,
        s.Label,
        s.Date,
        s.Meal,
        s.Servings,
        s.SortOrder,
        s.IsCooked,
        s.ParentSlotId,
        s.CreatedAt,
        s.UpdatedAt);

    private static MealPlanDto ToDto(MealPlan plan, IReadOnlyList<MealPlanSlot> slots)
    {
        var ordered = slots
            .OrderBy(s => s.Date)
            .ThenBy(s => s.Meal)
            .ThenBy(s => s.SortOrder)
            .Select(ToDto)
            .ToArray();
        return new MealPlanDto(
            plan.Id, plan.GroupId, plan.WeekStart, plan.Version,
            plan.CreatedAt, plan.UpdatedAt, ordered);
    }

    private static async Task<(MealPlan? Plan, IResult? Error)> LoadPlanWithMembershipAsync(
        AppDbContext db, Guid planId, Guid userId, CancellationToken ct)
    {
        var plan = await db.MealPlans.FirstOrDefaultAsync(p => p.Id == planId, ct);
        if (plan is null)
            return (null, FamilienResults.NotFound("mealplan.not_found", "MealPlan wurde nicht gefunden."));
        if (!await IsGroupMemberAsync(db, plan.GroupId, userId, ct))
            return (null, Results.Forbid());
        return (plan, null);
    }

    // ── GET /api/groups/{groupId}/mealplans/{weekStart} ─────────────

    private static async Task<IResult> GetMealPlanAsync(
        Guid groupId,
        string weekStart,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        if (!TryParseIsoDate(weekStart, out var week))
            return FamilienResults.BadRequest("weekstart.invalid_format",
                "weekStart muss das Format YYYY-MM-DD haben.");
        if (!IsMonday(week))
            return FamilienResults.BadRequest("weekstart.not_monday",
                "weekStart muss ein Montag sein.");

        var groupExists = await db.Groups.AnyAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (!groupExists) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        var plan = await db.MealPlans
            .FirstOrDefaultAsync(p => p.GroupId == groupId && p.WeekStart == week, ct);
        if (plan is null)
            return FamilienResults.NotFound("mealplan.not_found",
                "Für diese Woche existiert noch kein Wochenplan.");

        var slots = await db.MealPlanSlots
            .Where(s => s.MealPlanId == plan.Id)
            .ToListAsync(ct);
        return Results.Ok(ToDto(plan, slots));
    }

    // ── POST /api/groups/{groupId}/mealplans ────────────────────────

    private static async Task<IResult> CreateMealPlanAsync(
        Guid groupId,
        CreateMealPlanRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        if (!IsMonday(body.WeekStart))
            return FamilienResults.BadRequest("weekstart.not_monday",
                "weekStart muss ein Montag sein.");

        var groupExists = await db.Groups.AnyAsync(g => g.Id == groupId && g.DeletedAt == null, ct);
        if (!groupExists) return Results.NotFound();
        if (!await IsGroupMemberAsync(db, groupId, userId, ct)) return Results.Forbid();

        // Idempotent: if a plan already exists for this (group, week),
        // return it with 200 OK. The unique index enforces the invariant
        // at the DB level in case two clients race here.
        var existing = await db.MealPlans
            .FirstOrDefaultAsync(p => p.GroupId == groupId && p.WeekStart == body.WeekStart, ct);
        if (existing is not null)
        {
            var slots = await db.MealPlanSlots
                .Where(s => s.MealPlanId == existing.Id)
                .ToListAsync(ct);
            return Results.Ok(ToDto(existing, slots));
        }

        var now = clock.GetUtcNow();
        MealPlan plan;
        try
        {
            plan = new MealPlan(groupId, body.WeekStart, now);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }
        db.MealPlans.Add(plan);
        await db.SaveChangesAsync(ct);

        return Results.Created(
            $"/api/groups/{groupId}/mealplans/{plan.WeekStart:yyyy-MM-dd}",
            ToDto(plan, Array.Empty<MealPlanSlot>()));
    }

    // ── POST /api/mealplans/{planId}/slots ──────────────────────────

    private static async Task<IResult> AddSlotAsync(
        Guid planId,
        AddSlotRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        // If a RecipeId is supplied, it must belong to the same group.
        if (body.RecipeId is { } recipeId)
        {
            var recipeOk = await db.Recipes
                .AnyAsync(r => r.Id == recipeId && r.GroupId == plan!.GroupId && r.DeletedAt == null, ct);
            if (!recipeOk)
                return FamilienResults.BadRequest("recipe.not_in_group",
                    "Das Rezept gehört nicht zur Gruppe dieses Wochenplans.");
        }

        MealPlanSlot slot;
        var now = clock.GetUtcNow();
        try
        {
            var sortOrder = body.SortOrder ?? await NextSortOrderAsync(db, plan!.Id, body.Date, body.Meal, ct);
            slot = new MealPlanSlot(
                mealPlanId: plan!.Id,
                weekStart: plan.WeekStart,
                date: body.Date,
                meal: body.Meal,
                servings: body.Servings,
                recipeId: body.RecipeId,
                label: body.Label,
                sortOrder: sortOrder,
                createdAt: now);
        }
        catch (ArgumentOutOfRangeException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        // Parent must belong to the same plan; rely on the domain guard
        // (SetParent) for cycle + cross-plan enforcement.
        if (body.ParentSlotId is { } parentId)
        {
            var parent = await db.MealPlanSlots
                .FirstOrDefaultAsync(s => s.Id == parentId, ct);
            if (parent is null)
                return FamilienResults.BadRequest("parent.not_found",
                    "Der Parent-Slot wurde nicht gefunden.");
            if (parent.MealPlanId != plan.Id)
                return FamilienResults.BadRequest("parent.cross_plan",
                    "Der Parent-Slot gehört zu einem anderen Wochenplan.");
            try
            {
                slot.SetParent(parent, now);
            }
            catch (InvalidOperationException ex)
            {
                return FamilienResults.BadRequest("parent.cross_plan", ex.Message);
            }
        }

        db.MealPlanSlots.Add(slot);
        plan.BumpVersion(now);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/api/mealplans/{plan.Id}/slots/{slot.Id}", ToDto(slot));
    }

    private static async Task<int> NextSortOrderAsync(
        AppDbContext db, Guid planId, DateOnly date, MealSlot meal, CancellationToken ct)
    {
        var anyExisting = await db.MealPlanSlots
            .AnyAsync(s => s.MealPlanId == planId && s.Date == date && s.Meal == meal, ct);
        if (!anyExisting) return 0;
        var max = await db.MealPlanSlots
            .Where(s => s.MealPlanId == planId && s.Date == date && s.Meal == meal)
            .MaxAsync(s => s.SortOrder, ct);
        return max + 1;
    }

    // ── PATCH /api/mealplans/{planId}/slots/{slotId} ────────────────

    private static async Task<IResult> PatchSlotAsync(
        Guid planId,
        Guid slotId,
        HttpRequest request,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        var slot = await db.MealPlanSlots
            .FirstOrDefaultAsync(s => s.Id == slotId, ct);
        if (slot is null || slot.MealPlanId != plan!.Id)
            return FamilienResults.NotFound("slot.not_found",
                "Slot wurde nicht gefunden.");

        SlotPatch patch;
        try
        {
            patch = await SlotPatch.ReadAsync(request, ct);
        }
        catch (JsonException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        var now = clock.GetUtcNow();

        try
        {
            // RecipeId — null clears, Guid sets. Cross-group recipe is
            // rejected with the same code as AddSlot.
            if (patch.RecipeIdPresent)
            {
                if (patch.RecipeId is { } rid)
                {
                    var recipeOk = await db.Recipes
                        .AnyAsync(r => r.Id == rid && r.GroupId == plan!.GroupId && r.DeletedAt == null, ct);
                    if (!recipeOk)
                        return FamilienResults.BadRequest("recipe.not_in_group",
                            "Das Rezept gehört nicht zur Gruppe dieses Wochenplans.");
                }
                slot.SetRecipe(patch.RecipeId, now);
            }

            if (patch.LabelPresent)
                slot.SetLabel(patch.Label, now);

            if (patch.ServingsPresent && patch.Servings is { } servings)
                slot.UpdateServings(servings, now);

            if (patch.SortOrderPresent && patch.SortOrder is { } so)
                slot.Reorder(so, now);

            if (patch.IsCookedPresent && patch.IsCooked is { } cooked)
                slot.SetCooked(cooked, now);

            if (patch.ParentSlotIdPresent)
            {
                if (patch.ParentSlotId is { } pid)
                {
                    // Must load the parent FRESH with the owning plan so
                    // the cross-plan guard in SetParent can see the
                    // correct MealPlanId. Endpoint-layer check per plan
                    // §P3-1 reviewer guidance — enforce before domain
                    // call so a cleaner error code lands on the wire.
                    var parent = await db.MealPlanSlots
                        .FirstOrDefaultAsync(s => s.Id == pid, ct);
                    if (parent is null)
                        return FamilienResults.BadRequest("parent.not_found",
                            "Der Parent-Slot wurde nicht gefunden.");
                    if (parent.MealPlanId != plan!.Id)
                        return FamilienResults.BadRequest("parent.cross_plan",
                            "Der Parent-Slot gehört zu einem anderen Wochenplan.");
                    slot.SetParent(parent, now);
                }
                else
                {
                    slot.SetParent(null, now);
                }
            }
        }
        catch (ArgumentOutOfRangeException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }
        catch (ArgumentException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }
        catch (InvalidOperationException ex)
        {
            // Domain rejects cross-plan / cycle.
            return FamilienResults.BadRequest("parent.cross_plan", ex.Message);
        }

        plan!.BumpVersion(now);
        await db.SaveChangesAsync(ct);

        return Results.Ok(ToDto(slot));
    }

    // ── DELETE /api/mealplans/{planId}/slots/{slotId} ───────────────

    private static async Task<IResult> DeleteSlotAsync(
        Guid planId,
        Guid slotId,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        var slot = await db.MealPlanSlots
            .FirstOrDefaultAsync(s => s.Id == slotId, ct);
        if (slot is null || slot.MealPlanId != plan!.Id)
            return FamilienResults.NotFound("slot.not_found",
                "Slot wurde nicht gefunden.");

        // Per plan §P3-1: preserve user work by nulling out children's
        // ParentSlotId BEFORE deleting this slot rather than letting the
        // FK cascade nuke them. The SetNull FK behaviour would also
        // handle this, but we detach explicitly so child slots survive
        // as normal freeform entries the user can re-parent later.
        var now = clock.GetUtcNow();
        var children = await db.MealPlanSlots
            .Where(s => s.ParentSlotId == slotId)
            .ToListAsync(ct);
        foreach (var child in children)
        {
            child.SetParent(null, now);
        }

        db.MealPlanSlots.Remove(slot);
        plan!.BumpVersion(now);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    // ── POST /api/mealplans/{planId}/copy-from/{sourceWeekStart} ───

    private static async Task<IResult> CopyFromAsync(
        Guid planId,
        string sourceWeekStart,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        if (!TryParseIsoDate(sourceWeekStart, out var sourceWeek))
            return FamilienResults.BadRequest("weekstart.invalid_format",
                "sourceWeekStart muss das Format YYYY-MM-DD haben.");
        if (!IsMonday(sourceWeek))
            return FamilienResults.BadRequest("weekstart.not_monday",
                "sourceWeekStart muss ein Montag sein.");

        var (targetPlan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        var sourcePlan = await db.MealPlans
            .FirstOrDefaultAsync(p => p.GroupId == targetPlan!.GroupId && p.WeekStart == sourceWeek, ct);
        if (sourcePlan is null)
            return FamilienResults.NotFound("source.not_found",
                "Quell-Wochenplan wurde nicht gefunden.");

        if (sourcePlan.Id == targetPlan!.Id)
            return FamilienResults.BadRequest("copy.same_plan",
                "Quell- und Ziel-Wochenplan sind identisch.");

        var sourceSlots = await db.MealPlanSlots
            .Where(s => s.MealPlanId == sourcePlan.Id)
            .ToListAsync(ct);

        var now = clock.GetUtcNow();
        var dayOffset = targetPlan.WeekStart.DayNumber - sourcePlan.WeekStart.DayNumber;

        // Two-pass copy so ParentSlotId can be remapped. First pass
        // creates all new slots with ParentSlotId=null; second pass
        // sets parents where both parent + child were copied.
        var idMap = new Dictionary<Guid, Guid>(sourceSlots.Count);
        var created = new List<MealPlanSlot>(sourceSlots.Count);
        foreach (var src in sourceSlots)
        {
            var newDate = src.Date.AddDays(dayOffset);
            var copy = new MealPlanSlot(
                mealPlanId: targetPlan.Id,
                weekStart: targetPlan.WeekStart,
                date: newDate,
                meal: src.Meal,
                servings: src.Servings,
                recipeId: src.RecipeId,
                label: src.Label,
                sortOrder: src.SortOrder,
                createdAt: now);
            idMap[src.Id] = copy.Id;
            created.Add(copy);
            db.MealPlanSlots.Add(copy);
        }

        // Parent remap: only link where the source parent was also
        // copied (i.e. both slots belonged to the source plan — a
        // ParentSlotId pointing outside the source plan couldn't have
        // been valid to begin with, but drop it defensively).
        for (var i = 0; i < sourceSlots.Count; i++)
        {
            var src = sourceSlots[i];
            if (src.ParentSlotId is not { } srcParentId) continue;
            if (!idMap.TryGetValue(srcParentId, out var newParentId)) continue;

            var copy = created[i];
            var parentCopy = created.First(c => c.Id == newParentId);
            copy.SetParent(parentCopy, now);
        }

        targetPlan.BumpVersion(now);
        await db.SaveChangesAsync(ct);

        var refreshed = await db.MealPlanSlots
            .Where(s => s.MealPlanId == targetPlan.Id)
            .ToListAsync(ct);
        return Results.Ok(ToDto(targetPlan, refreshed));
    }

    // ── Partial-update helpers ──────────────────────────────────────

    /// <summary>
    /// JSON Merge Patch helper. Reads the raw request body once and
    /// exposes a per-property "present" flag so endpoints can
    /// distinguish "field absent" (leave alone) from "field present
    /// with null" (clear). Written ad-hoc — the project has no shared
    /// Optional&lt;T&gt; type yet, so this stays local to the slot
    /// PATCH handler until a second endpoint needs the same
    /// semantics (at which point extract into a shared helper).
    /// </summary>
    private sealed class SlotPatch
    {
        public bool RecipeIdPresent { get; private set; }
        public Guid? RecipeId { get; private set; }

        public bool LabelPresent { get; private set; }
        public string? Label { get; private set; }

        public bool ServingsPresent { get; private set; }
        public int? Servings { get; private set; }

        public bool SortOrderPresent { get; private set; }
        public int? SortOrder { get; private set; }

        public bool IsCookedPresent { get; private set; }
        public bool? IsCooked { get; private set; }

        public bool ParentSlotIdPresent { get; private set; }
        public Guid? ParentSlotId { get; private set; }

        public static async Task<SlotPatch> ReadAsync(HttpRequest request, CancellationToken ct)
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, cancellationToken: ct);
            var root = doc.RootElement;
            var patch = new SlotPatch();
            if (root.ValueKind != JsonValueKind.Object)
                throw new JsonException("Body must be a JSON object.");

            foreach (var prop in root.EnumerateObject())
            {
                switch (prop.Name)
                {
                    case "recipeId":
                        patch.RecipeIdPresent = true;
                        patch.RecipeId = ReadNullableGuid(prop.Value, prop.Name);
                        break;
                    case "label":
                        patch.LabelPresent = true;
                        patch.Label = ReadNullableString(prop.Value, prop.Name);
                        break;
                    case "servings":
                        patch.ServingsPresent = true;
                        patch.Servings = ReadNullableInt(prop.Value, prop.Name);
                        break;
                    case "sortOrder":
                        patch.SortOrderPresent = true;
                        patch.SortOrder = ReadNullableInt(prop.Value, prop.Name);
                        break;
                    case "isCooked":
                        patch.IsCookedPresent = true;
                        patch.IsCooked = ReadNullableBool(prop.Value, prop.Name);
                        break;
                    case "parentSlotId":
                        patch.ParentSlotIdPresent = true;
                        patch.ParentSlotId = ReadNullableGuid(prop.Value, prop.Name);
                        break;
                    default:
                        // Unknown properties are ignored (forward-compat):
                        // clients that send newer fields to an older
                        // server degrade to a no-op rather than 400.
                        break;
                }
            }
            return patch;
        }

        private static Guid? ReadNullableGuid(JsonElement e, string name)
        {
            if (e.ValueKind == JsonValueKind.Null) return null;
            if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g))
                return g;
            throw new JsonException($"Feld '{name}' muss eine UUID oder null sein.");
        }

        private static string? ReadNullableString(JsonElement e, string name)
        {
            if (e.ValueKind == JsonValueKind.Null) return null;
            if (e.ValueKind == JsonValueKind.String) return e.GetString();
            throw new JsonException($"Feld '{name}' muss ein Text oder null sein.");
        }

        private static int? ReadNullableInt(JsonElement e, string name)
        {
            if (e.ValueKind == JsonValueKind.Null) return null;
            if (e.ValueKind == JsonValueKind.Number && e.TryGetInt32(out var i)) return i;
            throw new JsonException($"Feld '{name}' muss eine Zahl oder null sein.");
        }

        private static bool? ReadNullableBool(JsonElement e, string name)
        {
            if (e.ValueKind == JsonValueKind.Null) return null;
            if (e.ValueKind == JsonValueKind.True) return true;
            if (e.ValueKind == JsonValueKind.False) return false;
            throw new JsonException($"Feld '{name}' muss true, false oder null sein.");
        }
    }
}

