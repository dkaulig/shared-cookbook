using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using FamilienKochbuch.Api.Http;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.MealPlanning;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
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

    /// <summary>
    /// JSON Merge Patch DTO for the slot PATCH endpoint. Each field
    /// is a <see cref="JsonElement"/>? so we can distinguish "absent"
    /// (null reference → leave alone) from "present with null value"
    /// (clear). NOTE: the Minimal-API/STJ binder collapses both into
    /// a C# null, so the endpoint reads the raw body via
    /// <see cref="ReadAsync"/> and populates this record by hand from
    /// a <see cref="JsonDocument"/> walk — that's the only way to keep
    /// the Merge-Patch semantics intact. Once populated, callers use
    /// the typed accessors (<see cref="JsonElement.GetGuid"/>, etc.)
    /// inside a single <see cref="JsonException"/> guard.
    /// </summary>
    public record SlotPatchRequest(
        JsonElement? RecipeId,
        JsonElement? Label,
        JsonElement? Servings,
        JsonElement? SortOrder,
        JsonElement? IsCooked,
        JsonElement? ParentSlotId)
    {
        public static async Task<SlotPatchRequest> ReadAsync(HttpRequest request, CancellationToken ct)
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, cancellationToken: ct);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new JsonException("Body must be a JSON object.");

            JsonElement? recipeId = null, label = null, servings = null,
                sortOrder = null, isCooked = null, parentSlotId = null;
            foreach (var prop in root.EnumerateObject())
            {
                // Clone() is required so the JsonElement outlives the
                // JsonDocument we're disposing on the way out.
                switch (prop.Name)
                {
                    case "recipeId": recipeId = prop.Value.Clone(); break;
                    case "label": label = prop.Value.Clone(); break;
                    case "servings": servings = prop.Value.Clone(); break;
                    case "sortOrder": sortOrder = prop.Value.Clone(); break;
                    case "isCooked": isCooked = prop.Value.Clone(); break;
                    case "parentSlotId": parentSlotId = prop.Value.Clone(); break;
                    // Unknown properties are ignored (forward-compat):
                    // newer clients hitting older servers degrade to a
                    // no-op rather than 400.
                }
            }
            return new SlotPatchRequest(recipeId, label, servings, sortOrder, isCooked, parentSlotId);
        }
    }

    // PATCH body cap — 16 KB is generous for 6 small fields and
    // prevents an attacker tying up the JSON parser with megabytes
    // of garbage. Default Kestrel cap (~30 MB) was overkill.
    private const long PatchSlotBodyLimitBytes = 16_384;

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
        plan.MapPatch("/slots/{slotId:guid}", PatchSlotAsync)
            .WithMetadata(new RequestSizeLimitAttribute(PatchSlotBodyLimitBytes));
        plan.MapDelete("/slots/{slotId:guid}", DeleteSlotAsync);
        // P3-9 security — per-user 10/min rate limit on copy-from. The
        // endpoint walks every source slot + INSERTs a copy, so a rapid
        // double-click (or two open tabs) is both expensive AND the worst
        // foot-gun: server-side empty-target guard below catches the
        // duplicate-copy race, but we also want to blunt click-loops /
        // malicious replay. Reuses the existing Generate policy — same
        // "materialise a big list of things" cost profile as shopping-
        // list generate, so one shared bucket is fine.
        plan.MapPost("/copy-from/{sourceWeekStart}", CopyFromAsync)
            .RequireRateLimiting(RateLimitPolicies.Generate);
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

    /// <summary>
    /// OFF3: reads <c>If-Match</c> off <paramref name="request"/> and
    /// compares against the plan's <see cref="MealPlan.Version"/>. When
    /// the versions don't match (client is stale), returns a 409
    /// Conflict carrying the plan's current DTO — so the frontend can
    /// surface the server state without a follow-up GET. Returns
    /// <c>null</c> when there is no If-Match header (backward-compat)
    /// or when it matches.
    /// </summary>
    private static async Task<IResult?> BuildPlanConflictIfMismatchAsync(
        HttpRequest request, MealPlan plan, AppDbContext db, CancellationToken ct)
    {
        if (!request.Headers.TryGetValue("If-Match", out var raw)) return null;
        var parsed = ETagHelper.TryParse(raw.ToString());
        if (parsed is null) return null;

        var (expectedId, expectedVersion) = parsed.Value;
        if (expectedId == plan.Id && expectedVersion == plan.Version) return null;

        // Project current state once so the 409 body matches the shape a
        // normal GET returns.
        var slots = await db.MealPlanSlots
            .Where(s => s.MealPlanId == plan.Id)
            .ToListAsync(ct);
        return FamilienResults.Conflict(
            "version_mismatch",
            "Der Eintrag wurde zwischenzeitlich geändert.",
            (object?)ToDto(plan, slots));
    }

    /// <summary>
    /// Walks <paramref name="candidateId"/>'s ancestor chain via
    /// repeated DB lookups and returns every visited ID (including
    /// the candidate itself). Used by the parent-attach guard so we
    /// can detect cycles WITHOUT depending on the candidate's
    /// <see cref="MealPlanSlot.ParentSlot"/> nav being eager-loaded —
    /// the in-memory <see cref="MealPlanSlot.CanSetParent"/> guard
    /// can't see ancestors on a freshly-loaded entity, which is the
    /// hole the original PATCH path left open (two PATCHes could
    /// build A↔B by stepping the cycle through endpoints whose
    /// candidate.ParentSlot was always null).
    /// </summary>
    private static async Task<HashSet<Guid>> LoadAncestorIdsAsync(
        AppDbContext db, Guid candidateId, Guid planId, CancellationToken ct)
    {
        var ancestors = new HashSet<Guid> { candidateId };
        var cursorId = candidateId;
        while (true)
        {
            var parentId = await db.MealPlanSlots
                .Where(s => s.Id == cursorId && s.MealPlanId == planId)
                .Select(s => s.ParentSlotId)
                .FirstOrDefaultAsync(ct);
            if (parentId is null) break;
            if (!ancestors.Add(parentId.Value))
            {
                // Corrupt state — existing cycle in DB (shouldn't
                // happen given the same guard at write time). Bail
                // rather than spin forever.
                break;
            }
            cursorId = parentId.Value;
        }
        return ancestors;
    }

    /// <summary>
    /// Shared parent-attach helper for <see cref="AddSlotAsync"/> and
    /// <see cref="PatchSlotAsync"/>. Returns <c>null</c> on success
    /// (parent attached or detached as requested), or an error result
    /// when the candidate is missing, lives on a different plan, or
    /// would form a cycle.
    /// </summary>
    private static async Task<IResult?> TryAttachParentAsync(
        MealPlanSlot slot,
        Guid? parentId,
        MealPlan plan,
        AppDbContext db,
        DateTimeOffset now,
        CancellationToken ct)
    {
        if (parentId is null)
        {
            slot.SetParent(null, now);
            return null;
        }

        var parent = await db.MealPlanSlots
            .FirstOrDefaultAsync(s => s.Id == parentId.Value, ct);
        if (parent is null)
            return FamilienResults.BadRequest("parent.not_found",
                "Der Parent-Slot wurde nicht gefunden.");
        if (parent.MealPlanId != plan.Id)
            return FamilienResults.BadRequest("parent.cross_plan",
                "Der Parent-Slot gehört zu einem anderen Wochenplan.");

        // Endpoint-layer cycle check that survives detached-entity
        // reads — see LoadAncestorIdsAsync for the rationale.
        var ancestors = await LoadAncestorIdsAsync(db, parent.Id, plan.Id, ct);
        if (ancestors.Contains(slot.Id))
            return FamilienResults.BadRequest("parent.cycle",
                "Parent-Zuweisung würde einen Zyklus erzeugen.");

        try
        {
            slot.SetParent(parent, now);
        }
        catch (InvalidOperationException ex)
        {
            return FamilienResults.BadRequest("parent.cross_plan", ex.Message);
        }
        return null;
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
        return ETagHelper.Ok(ToDto(plan, slots), plan.Id, plan.Version);
    }

    // ── POST /api/groups/{groupId}/mealplans ────────────────────────

    private static async Task<IResult> CreateMealPlanAsync(
        Guid groupId,
        CreateMealPlanRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
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

        await liveSync.MealPlanChangedAsync(
            groupId: plan.GroupId,
            planId: plan.Id,
            weekStart: FormatWeekStart(plan.WeekStart),
            action: LiveSyncAction.Created,
            ct: ct);

        return Results.Created(
            $"/api/groups/{groupId}/mealplans/{plan.WeekStart:yyyy-MM-dd}",
            ToDto(plan, Array.Empty<MealPlanSlot>()));
    }

    /// <summary>Canonical ISO YYYY-MM-DD for the wire payload — kept
    /// invariant regardless of the server's culture.</summary>
    private static string FormatWeekStart(DateOnly weekStart) =>
        weekStart.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // ── POST /api/mealplans/{planId}/slots ──────────────────────────

    private static async Task<IResult> AddSlotAsync(
        Guid planId,
        AddSlotRequest body,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        // OFF3: adding a slot mutates the plan aggregate (Version
        // bumps), so the If-Match check is on MealPlan.Version. Absent
        // If-Match = pre-OFF3 client, proceed unchanged.
        var planConflict = await BuildPlanConflictIfMismatchAsync(httpRequest, plan!, db, ct);
        if (planConflict is not null) return planConflict;

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

        if (body.ParentSlotId is { } parentId)
        {
            var parentErr = await TryAttachParentAsync(slot, parentId, plan!, db, now, ct);
            if (parentErr is not null) return parentErr;
        }

        db.MealPlanSlots.Add(slot);
        plan!.BumpVersion(now);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildPlanConcurrencyConflictAsync(plan, db, ct);
        }

        await PublishSlotAndPlanChangedAsync(
            liveSync, plan, slot.Id, LiveSyncAction.Created, LiveSyncAction.Updated, ct);

        return Results.Created($"/api/mealplans/{plan.Id}/slots/{slot.Id}", ToDto(slot));
    }

    /// <summary>
    /// Publishes a <c>MealPlanSlotChanged</c> event alongside a
    /// <c>MealPlanChanged</c> (version-bump) event. Centralised here
    /// so every slot-mutation endpoint fans out the same event pair
    /// with the same payload shape.
    /// </summary>
    private static async Task PublishSlotAndPlanChangedAsync(
        ILiveSyncPublisher liveSync,
        MealPlan plan,
        Guid slotId,
        LiveSyncAction slotAction,
        LiveSyncAction planAction,
        CancellationToken ct)
    {
        var weekStart = FormatWeekStart(plan.WeekStart);
        await liveSync.MealPlanSlotChangedAsync(
            groupId: plan.GroupId,
            planId: plan.Id,
            slotId: slotId,
            weekStart: weekStart,
            action: slotAction,
            ct: ct);
        await liveSync.MealPlanChangedAsync(
            groupId: plan.GroupId,
            planId: plan.Id,
            weekStart: weekStart,
            action: planAction,
            ct: ct);
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
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        // OFF3: If-Match compares against MealPlan.Version since every
        // slot change bumps the plan's version.
        var planConflict = await BuildPlanConflictIfMismatchAsync(request, plan!, db, ct);
        if (planConflict is not null) return planConflict;

        var slot = await db.MealPlanSlots
            .FirstOrDefaultAsync(s => s.Id == slotId, ct);
        if (slot is null || slot.MealPlanId != plan!.Id)
            return FamilienResults.NotFound("slot.not_found",
                "Slot wurde nicht gefunden.");

        SlotPatchRequest patch;
        try
        {
            patch = await SlotPatchRequest.ReadAsync(request, ct);
        }
        catch (JsonException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
        }

        var now = clock.GetUtcNow();

        try
        {
            // RecipeId — null clears, Guid sets. Cross-group recipe
            // is rejected with the same code as AddSlot.
            if (IsSet(patch.RecipeId))
            {
                var rid = ReadNullableGuid(patch.RecipeId!.Value, "recipeId");
                if (rid is { } r)
                {
                    var recipeOk = await db.Recipes
                        .AnyAsync(x => x.Id == r && x.GroupId == plan!.GroupId && x.DeletedAt == null, ct);
                    if (!recipeOk)
                        return FamilienResults.BadRequest("recipe.not_in_group",
                            "Das Rezept gehört nicht zur Gruppe dieses Wochenplans.");
                }
                slot.SetRecipe(rid, now);
            }

            if (IsSet(patch.Label))
                slot.SetLabel(ReadNullableString(patch.Label!.Value, "label"), now);

            if (IsSet(patch.Servings) && ReadNullableInt(patch.Servings!.Value, "servings") is { } srv)
                slot.UpdateServings(srv, now);

            if (IsSet(patch.SortOrder) && ReadNullableInt(patch.SortOrder!.Value, "sortOrder") is { } so)
                slot.Reorder(so, now);

            if (IsSet(patch.IsCooked) && ReadNullableBool(patch.IsCooked!.Value, "isCooked") is { } cooked)
                slot.SetCooked(cooked, now);

            if (IsSet(patch.ParentSlotId))
            {
                var pid = ReadNullableGuid(patch.ParentSlotId!.Value, "parentSlotId");
                var parentErr = await TryAttachParentAsync(slot, pid, plan!, db, now, ct);
                if (parentErr is not null) return parentErr;
            }
        }
        catch (JsonException ex)
        {
            return FamilienResults.BadRequest("invalid_input", ex.Message);
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
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildPlanConcurrencyConflictAsync(plan, db, ct);
        }

        await PublishSlotAndPlanChangedAsync(
            liveSync, plan, slot.Id, LiveSyncAction.Updated, LiveSyncAction.Updated, ct);

        return Results.Ok(ToDto(slot));
    }

    // ── DELETE /api/mealplans/{planId}/slots/{slotId} ───────────────

    private static async Task<IResult> DeleteSlotAsync(
        Guid planId,
        Guid slotId,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        // OFF3: the plan's Version is the concurrency token the client
        // holds when deleting a slot.
        var planConflict = await BuildPlanConflictIfMismatchAsync(httpRequest, plan!, db, ct);
        if (planConflict is not null) return planConflict;

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
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildPlanConcurrencyConflictAsync(plan, db, ct);
        }

        await PublishSlotAndPlanChangedAsync(
            liveSync, plan, slotId, LiveSyncAction.Deleted, LiveSyncAction.Updated, ct);

        return Results.NoContent();
    }

    // ── POST /api/mealplans/{planId}/copy-from/{sourceWeekStart} ───

    private static async Task<IResult> CopyFromAsync(
        Guid planId,
        string sourceWeekStart,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
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

        // OFF3: copy-from bumps the target plan's version (it's the
        // mutated aggregate), so the If-Match check is against it.
        var planConflict = await BuildPlanConflictIfMismatchAsync(httpRequest, targetPlan!, db, ct);
        if (planConflict is not null) return planConflict;

        // P3-9 empty-target guard. A rapid double-click (or two open tabs)
        // would otherwise fire two POSTs and end up with 2× slots, because
        // the frontend's button-disabled check lags cache state. Enforcing
        // "copy only into an empty plan" server-side is cheap and closes
        // the race entirely — the UI still shows a warn-confirm() on the
        // unlikely SignalR-repopulation path, but we no longer rely on it.
        var existingSlotCount = await db.MealPlanSlots
            .CountAsync(s => s.MealPlanId == planId, ct);
        if (existingSlotCount > 0)
            return FamilienResults.Conflict("copy.target_not_empty",
                "Zielplan enthält bereits Slots — Kopieren nur in leeren Plan möglich.");

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
        var newById = new Dictionary<Guid, MealPlanSlot>(sourceSlots.Count);
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
            newById[copy.Id] = copy;
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
            var parentCopy = newById[newParentId];
            copy.SetParent(parentCopy, now);
        }

        targetPlan.BumpVersion(now);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildPlanConcurrencyConflictAsync(targetPlan, db, ct);
        }

        await liveSync.MealPlanChangedAsync(
            groupId: targetPlan.GroupId,
            planId: targetPlan.Id,
            weekStart: FormatWeekStart(targetPlan.WeekStart),
            action: LiveSyncAction.Updated,
            ct: ct);

        var refreshed = await db.MealPlanSlots
            .Where(s => s.MealPlanId == targetPlan.Id)
            .ToListAsync(ct);
        return Results.Ok(ToDto(targetPlan, refreshed));
    }

    /// <summary>
    /// OFF3: builds a 409 response after an EF
    /// <see cref="DbUpdateConcurrencyException"/>. Reloads the plan's
    /// current state from the DB (the tracked entity is in an unknown
    /// state after the failed save) and projects it into a MealPlanDto
    /// that mirrors a normal GET's body shape. Used by every plan-
    /// mutation endpoint so concurrent writers get the same conflict
    /// wire-shape regardless of which slot-level call raced first.
    /// </summary>
    private static async Task<IResult> BuildPlanConcurrencyConflictAsync(
        MealPlan plan, AppDbContext db, CancellationToken ct)
    {
        // The entity in the change tracker is in a failed-save limbo
        // state; fetch a fresh AsNoTracking copy so projecting the DTO
        // reflects the winning writer's state.
        var fresh = await db.MealPlans.AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == plan.Id, ct);
        MealPlanDto currentDto;
        if (fresh is null)
        {
            // Extremely unlikely — the plan was deleted between the read
            // and the concurrency exception. Fall back to the stale
            // in-memory entity so the client still sees *something*.
            currentDto = ToDto(plan, Array.Empty<MealPlanSlot>());
        }
        else
        {
            var slots = await db.MealPlanSlots.AsNoTracking()
                .Where(s => s.MealPlanId == fresh.Id)
                .ToListAsync(ct);
            currentDto = ToDto(fresh, slots);
        }
        return FamilienResults.Conflict(
            "version_mismatch",
            "Der Eintrag wurde zwischenzeitlich geändert.",
            (object?)currentDto);
    }

    // ── Partial-update helpers ──────────────────────────────────────

    /// <summary>
    /// True when the JSON key was present in the body, regardless of
    /// whether the value was JSON null or a real value. Models the
    /// "absent vs present-with-null" distinction that JSON Merge Patch
    /// requires.
    /// </summary>
    private static bool IsSet(JsonElement? e) => e.HasValue;

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
