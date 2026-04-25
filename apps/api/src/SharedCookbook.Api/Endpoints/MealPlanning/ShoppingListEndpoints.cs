using System.Security.Claims;
using System.Text.Json;
using SharedCookbook.Api.Http;
using SharedCookbook.Api.Hubs;
using SharedCookbook.Api.Services;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Domain.Enums;
using SharedCookbook.Domain.MealPlanning;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace SharedCookbook.Api.Endpoints.MealPlanning;

/// <summary>
/// P3-5 shopping-list endpoints. Five routes: GET the persisted list,
/// POST /generate (first-time or merge-regen), PATCH an item (toggle
/// IsChecked + optional note edit), POST a manual item, DELETE an item.
/// Every endpoint is group-member auth (via MealPlan → Group membership).
/// </summary>
public static class ShoppingListEndpoints
{
    // ── Request / response DTOs ─────────────────────────────────────

    public record ShoppingListItemDto(
        Guid Id,
        Guid ShoppingListId,
        string Name,
        string? Quantity,
        string? Unit,
        string? Note,
        bool IsChecked,
        IngredientCategory Category,
        ShoppingListItemSource Source,
        int SortOrder,
        bool CarriedOverFromPreviousWeek,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt);

    public record ShoppingListDto(
        Guid Id,
        Guid MealPlanId,
        // OFF3: client mirrors this into the ETag for subsequent
        // mutations. Starts at 0, bumps on every list-level change.
        int Version,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        DateTimeOffset LastGeneratedAt,
        ShoppingListItemDto[] Items);

    public record AddItemRequest(
        string Name,
        string? Quantity = null,
        string? Unit = null,
        string? Note = null,
        IngredientCategory? Category = null);

    /// <summary>
    /// PATCH body for <c>/api/shopping-lists/{id}/items/{itemId}</c>.
    /// JSON Merge Patch semantics: field absent → untouched; field
    /// explicit-null → cleared (for nullable strings). Only
    /// <c>isChecked</c> and <c>note</c> are mutable via PATCH —
    /// name/unit/quantity/category are immutable because changing
    /// them would desync the merge-by-key invariants the generator
    /// relies on.
    /// </summary>
    public record ItemPatchRequest(
        JsonElement? IsChecked,
        JsonElement? Note)
    {
        public static async Task<ItemPatchRequest> ReadAsync(HttpRequest request, CancellationToken ct)
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, cancellationToken: ct);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new JsonException("Body must be a JSON object.");

            JsonElement? isChecked = null, note = null;
            foreach (var prop in root.EnumerateObject())
            {
                switch (prop.Name)
                {
                    case "isChecked": isChecked = prop.Value.Clone(); break;
                    case "note": note = prop.Value.Clone(); break;
                    // Unknown properties ignored for forward-compat.
                }
            }
            return new ItemPatchRequest(isChecked, note);
        }
    }

    private const long PatchBodyLimitBytes = 16_384;

    // ── Endpoint wiring ─────────────────────────────────────────────

    public static void MapShoppingListEndpoints(this WebApplication app)
    {
        var plan = app.MapGroup("/api/mealplans/{planId:guid}")
            .WithTags("ShoppingList")
            .RequireAuthorization();
        plan.MapGet("/shopping-list", GetAsync);
        // POST /generate is per-user rate-limited (10/min) to blunt
        // runaway-client loops or malicious repeat calls — the regen
        // path walks all slots + recipes + ingredients + existing
        // list rows, so it's the most expensive endpoint in this
        // group. See Program.cs → RateLimitPolicies.Generate.
        plan.MapPost("/shopping-list/generate", GenerateAsync)
            .RequireRateLimiting(RateLimitPolicies.Generate);

        var list = app.MapGroup("/api/shopping-lists/{listId:guid}")
            .WithTags("ShoppingList")
            .RequireAuthorization();
        list.MapPost("/items", AddItemAsync);
        list.MapPatch("/items/{itemId:guid}", PatchItemAsync)
            .WithMetadata(new RequestSizeLimitAttribute(PatchBodyLimitBytes));
        list.MapDelete("/items/{itemId:guid}", DeleteItemAsync);
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

    private static async Task<(MealPlan? Plan, IResult? Error)> LoadPlanWithMembershipAsync(
        AppDbContext db, Guid planId, Guid userId, CancellationToken ct)
    {
        var plan = await db.MealPlans.FirstOrDefaultAsync(p => p.Id == planId, ct);
        if (plan is null)
            return (null, FamilienResults.NotFound(
                ErrorCodes.MealplanNotFound, "Meal plan not found."));
        if (!await IsGroupMemberAsync(db, plan.GroupId, userId, ct))
            return (null, Results.Forbid());
        return (plan, null);
    }

    /// <summary>
    /// OFF3: checks the <c>If-Match</c> header on <paramref name="request"/>
    /// against the list's <see cref="ShoppingList.Version"/>. Returns
    /// <c>null</c> when there's no header (backward-compat) or the
    /// versions match; otherwise a 409 Conflict with the current list
    /// DTO so the client can reconcile without a follow-up GET.
    /// </summary>
    private static async Task<IResult?> BuildListConflictIfMismatchAsync(
        HttpRequest request, ShoppingList list, AppDbContext db, CancellationToken ct)
    {
        if (!request.Headers.TryGetValue("If-Match", out var raw)) return null;
        var parsed = ETagHelper.TryParse(raw.ToString());
        if (parsed is null) return null;

        var (expectedId, expectedVersion) = parsed.Value;
        if (expectedId == list.Id && expectedVersion == list.Version) return null;

        var items = await db.ShoppingListItems
            .Where(i => i.ShoppingListId == list.Id)
            .ToListAsync(ct);
        return FamilienResults.Conflict(
            ErrorCodes.VersionMismatch,
            "Version mismatch; reload and retry.",
            (object?)ToDto(list, items));
    }

    /// <summary>
    /// OFF3: projects the list's authoritative current state after an
    /// EF <see cref="DbUpdateConcurrencyException"/> into a 409 body.
    /// Mirrors the shape a GET returns so the caller's reconciliation
    /// logic handles both pre-save mismatches and TOCTOU races the
    /// same way.
    /// </summary>
    private static async Task<IResult> BuildListConcurrencyConflictAsync(
        ShoppingList list, AppDbContext db, CancellationToken ct)
    {
        var fresh = await db.ShoppingLists.AsNoTracking()
            .FirstOrDefaultAsync(l => l.Id == list.Id, ct);
        ShoppingListDto currentDto;
        if (fresh is null)
        {
            currentDto = ToDto(list, Array.Empty<ShoppingListItem>());
        }
        else
        {
            var items = await db.ShoppingListItems.AsNoTracking()
                .Where(i => i.ShoppingListId == fresh.Id)
                .ToListAsync(ct);
            currentDto = ToDto(fresh, items);
        }
        return FamilienResults.Conflict(
            ErrorCodes.VersionMismatch,
            "Version mismatch; reload and retry.",
            (object?)currentDto);
    }

    private static async Task<(ShoppingList? List, MealPlan? Plan, IResult? Error)> LoadListWithMembershipAsync(
        AppDbContext db, Guid listId, Guid userId, CancellationToken ct)
    {
        var list = await db.ShoppingLists.FirstOrDefaultAsync(l => l.Id == listId, ct);
        if (list is null)
            return (null, null, FamilienResults.NotFound(
                ErrorCodes.ShoppingListNotFound, "Shopping list not found."));
        var plan = await db.MealPlans.FirstOrDefaultAsync(p => p.Id == list.MealPlanId, ct);
        if (plan is null)
            // Orphan list — shouldn't happen given the cascade FK, but
            // treat like a missing plan so we fail fast rather than
            // leak the row.
            return (null, null, FamilienResults.NotFound(
                ErrorCodes.MealplanNotFound, "Meal plan not found."));
        if (!await IsGroupMemberAsync(db, plan.GroupId, userId, ct))
            return (null, null, Results.Forbid());
        return (list, plan, null);
    }

    private static ShoppingListItemDto ToDto(ShoppingListItem i) => new(
        i.Id, i.ShoppingListId, i.Name, i.Quantity, i.Unit, i.Note,
        i.IsChecked, i.Category, i.Source, i.SortOrder,
        i.CarriedOverFromPreviousWeek, i.CreatedAt, i.UpdatedAt);

    private static ShoppingListDto ToDto(ShoppingList list, IReadOnlyList<ShoppingListItem> items)
    {
        var ordered = items
            .OrderBy(i => i.Category)
            .ThenBy(i => i.SortOrder)
            .ThenBy(i => i.Name, StringComparer.InvariantCultureIgnoreCase)
            .Select(ToDto)
            .ToArray();
        return new ShoppingListDto(
            list.Id, list.MealPlanId, list.Version,
            list.CreatedAt, list.UpdatedAt,
            list.LastGeneratedAt, ordered);
    }

    // ── GET /api/mealplans/{planId}/shopping-list ───────────────────

    private static async Task<IResult> GetAsync(
        Guid planId,
        ClaimsPrincipal principal,
        AppDbContext db,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        var list = await db.ShoppingLists
            .FirstOrDefaultAsync(l => l.MealPlanId == plan!.Id, ct);
        if (list is null)
            return FamilienResults.NotFound(
                ErrorCodes.ShoppingListNotFound,
                "No shopping list exists for this meal plan yet. Generate one via POST /shopping-list/generate.");

        var items = await db.ShoppingListItems
            .Where(i => i.ShoppingListId == list.Id)
            .ToListAsync(ct);
        return ETagHelper.Ok(ToDto(list, items), list.Id, list.Version);
    }

    // ── POST /api/mealplans/{planId}/shopping-list/generate ─────────

    private static async Task<IResult> GenerateAsync(
        Guid planId,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (plan, err) = await LoadPlanWithMembershipAsync(db, planId, userId, ct);
        if (err is not null) return err;

        var now = clock.GetUtcNow();

        // Load the plan's slots + the recipes they reference (with
        // ingredients). Two round-trips keeps the IN clause small.
        var slots = await db.MealPlanSlots
            .Where(s => s.MealPlanId == plan!.Id)
            .ToListAsync(ct);
        plan!.Slots.Clear();
        foreach (var s in slots) plan.Slots.Add(s);

        var recipeIds = slots
            .Where(s => s.RecipeId is not null)
            .Select(s => s.RecipeId!.Value)
            .Distinct()
            .ToList();

        var recipes = await db.Recipes
            .Include(r => r.Ingredients)
            .Where(r => recipeIds.Contains(r.Id))
            .ToListAsync(ct);
        var recipesById = recipes.ToDictionary(r => r.Id);

        // Is this a first-time generate or a regen?
        var existing = await db.ShoppingLists
            .FirstOrDefaultAsync(l => l.MealPlanId == plan.Id, ct);

        if (existing is null)
        {
            // ── First-time generate: apply carryover from previous
            //    week if a list exists for the previous Monday.
            var prevWeekStart = plan.WeekStart.AddDays(-7);
            var prevPlan = await db.MealPlans
                .FirstOrDefaultAsync(p => p.GroupId == plan.GroupId && p.WeekStart == prevWeekStart, ct);

            IReadOnlyCollection<ShoppingListGenerator.CarryoverCandidate>? carryover = null;
            if (prevPlan is not null)
            {
                var prevList = await db.ShoppingLists
                    .FirstOrDefaultAsync(l => l.MealPlanId == prevPlan.Id, ct);
                if (prevList is not null)
                {
                    carryover = await db.ShoppingListItems
                        .Where(i => i.ShoppingListId == prevList.Id)
                        .Select(i => new ShoppingListGenerator.CarryoverCandidate(
                            i.Name, i.Quantity, i.Unit, i.Note,
                            i.Category, i.Source, i.IsChecked))
                        .ToListAsync(ct);
                }
            }

            var computed = ShoppingListGenerator.Generate(plan, recipesById, carryover);

            var list = new ShoppingList(plan.Id, now);
            foreach (var c in computed)
            {
                list.Items.Add(new ShoppingListItem(
                    shoppingListId: list.Id,
                    name: c.Name,
                    quantity: c.Quantity,
                    unit: c.Unit,
                    note: c.Note,
                    category: c.Category,
                    source: c.Source,
                    sortOrder: c.SortOrder,
                    carriedOverFromPreviousWeek: c.CarriedOverFromPreviousWeek,
                    createdAt: now));
            }
            db.ShoppingLists.Add(list);
            await db.SaveChangesAsync(ct);

            // itemId=Guid.Empty signals a list-wide change — the
            // frontend invalidates the whole ['shoppinglist', planId]
            // query rather than trying to splice individual rows from
            // a bulk-generate. Same convention applied on regen below.
            await liveSync.ShoppingListItemChangedAsync(
                groupId: plan.GroupId,
                planId: plan.Id,
                listId: list.Id,
                itemId: Guid.Empty,
                action: LiveSyncAction.Created,
                ct: ct);

            return Results.Created(
                $"/api/mealplans/{plan.Id}/shopping-list",
                ToDto(list, list.Items.ToList()));
        }

        // ── Regen path: merge new ingredients without touching user
        //    check-offs or manual items. Carryover is NOT re-applied
        //    (plan §Carryover: subsequent regenerates do not repeat
        //    the merge — otherwise checked carryover items would
        //    silently change provenance).
        var existingItems = await db.ShoppingListItems
            .Where(i => i.ShoppingListId == existing.Id)
            .ToListAsync(ct);

        var recomputed = ShoppingListGenerator.Generate(plan, recipesById, carryoverCandidates: null);

        ApplyRegenMerge(db, existing, existingItems, recomputed, now);

        existing.MarkRegenerated(now);
        await db.SaveChangesAsync(ct);

        await liveSync.ShoppingListItemChangedAsync(
            groupId: plan.GroupId,
            planId: plan.Id,
            listId: existing.Id,
            itemId: Guid.Empty,
            action: LiveSyncAction.Updated,
            ct: ct);

        var refreshed = await db.ShoppingListItems
            .Where(i => i.ShoppingListId == existing.Id)
            .ToListAsync(ct);
        return Results.Ok(ToDto(existing, refreshed));
    }

    /// <summary>
    /// Three-phase merge applied on regen: (1) update-in-place
    /// existing FromPlan/CarriedOver rows that still match a
    /// recomputed (name, unit) key so user-driven flags like
    /// <c>IsChecked</c> survive; (2) insert recomputed rows that
    /// don't match anything existing (new ingredient added to a
    /// slot); (3) drop stale FromPlan/CarriedOver rows whose slot
    /// was deleted. Manual items always survive. Mutates
    /// <paramref name="existingItems"/> and the <paramref name="db"/>
    /// change tracker in place.
    /// </summary>
    private static void ApplyRegenMerge(
        AppDbContext db,
        ShoppingList existing,
        List<ShoppingListItem> existingItems,
        IReadOnlyList<ShoppingListGenerator.ComputedShoppingItem> recomputed,
        DateTimeOffset now)
    {
        // Build a lookup keyed by (name.lower, unit.lower) so we can
        // match recomputed rows to existing rows for in-place update.
        static string KeyFor(string name, string? unit) =>
            $"{name.ToLowerInvariant()}||{(unit ?? string.Empty).ToLowerInvariant()}";

        var existingByKey = existingItems
            .Where(i => i.Source == ShoppingListItemSource.FromPlan
                     || i.Source == ShoppingListItemSource.CarriedOver)
            .GroupBy(i => KeyFor(i.Name, i.Unit))
            // If there are dupes (shouldn't happen — the generator
            // merged on the same key), take the first so the path
            // stays deterministic.
            .ToDictionary(g => g.Key, g => g.First());

        var keepIds = new HashSet<Guid>();
        // Phase 0: manual items always survive regen.
        foreach (var i in existingItems.Where(i => i.Source == ShoppingListItemSource.Manual))
            keepIds.Add(i.Id);

        // Phase 1 + 2: update-in-place or insert new.
        foreach (var c in recomputed)
        {
            var key = KeyFor(c.Name, c.Unit);
            if (existingByKey.TryGetValue(key, out var match))
            {
                // In-place update: refresh quantity + note + sort
                // order, preserve IsChecked + Source so a
                // previously-carried-over item doesn't flip back to
                // FromPlan on regen.
                match.SetQuantity(c.Quantity, now);
                match.SetNote(c.Note, now);
                match.Reorder(c.SortOrder, now);
                match.SetCategory(c.Category, now);
                keepIds.Add(match.Id);
            }
            else
            {
                // New ingredient — started eating more of X. Insert
                // as a fresh FromPlan row.
                var fresh = new ShoppingListItem(
                    shoppingListId: existing.Id,
                    name: c.Name,
                    quantity: c.Quantity,
                    unit: c.Unit,
                    note: c.Note,
                    category: c.Category,
                    source: c.Source,
                    sortOrder: c.SortOrder,
                    carriedOverFromPreviousWeek: c.CarriedOverFromPreviousWeek,
                    createdAt: now);
                db.ShoppingListItems.Add(fresh);
                keepIds.Add(fresh.Id);
            }
        }

        // Phase 3: drop stale FromPlan / CarriedOver rows — the user
        // removed a slot so the aggregated ingredient isn't needed
        // anymore. We only drop non-manual rows to preserve user-
        // typed entries.
        var toDelete = existingItems
            .Where(i => i.Source != ShoppingListItemSource.Manual && !keepIds.Contains(i.Id))
            .ToList();
        db.ShoppingListItems.RemoveRange(toDelete);
    }

    // ── POST /api/shopping-lists/{listId}/items ─────────────────────

    private static async Task<IResult> AddItemAsync(
        Guid listId,
        AddItemRequest body,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (list, plan, err) = await LoadListWithMembershipAsync(db, listId, userId, ct);
        if (err is not null) return err;

        // OFF3: list.Version is the concurrency token for manual-add.
        var listConflict = await BuildListConflictIfMismatchAsync(httpRequest, list!, db, ct);
        if (listConflict is not null) return listConflict;

        // Reject out-of-range enum values: System.Text.Json happily
        // deserializes any int into an enum, so `{ "category": 9999 }`
        // would otherwise persist a nonsense bucket that UIs can't
        // render and downstream sort code can't group.
        if (body.Category is { } cat && !Enum.IsDefined(typeof(IngredientCategory), cat))
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidCategory,
                "Unknown ingredient category.",
                fieldName: "category");

        var now = clock.GetUtcNow();

        ShoppingListItem item;
        try
        {
            // Manual items go at the end of their category bucket:
            // sortOrder = max(existing) + 10, isolated per category.
            var maxSortInCategory = await db.ShoppingListItems
                .Where(i => i.ShoppingListId == list!.Id
                         && i.Category == (body.Category ?? IngredientCategory.Sonstiges))
                .Select(i => (int?)i.SortOrder)
                .MaxAsync(ct);
            var nextSort = (maxSortInCategory ?? -10) + 10;

            item = new ShoppingListItem(
                shoppingListId: list!.Id,
                name: body.Name,
                quantity: body.Quantity,
                unit: body.Unit,
                note: body.Note,
                category: body.Category ?? IngredientCategory.Sonstiges,
                source: ShoppingListItemSource.Manual,
                sortOrder: nextSort,
                carriedOverFromPreviousWeek: false,
                createdAt: now);
        }
        catch (ArgumentException)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid shopping list payload.");
        }

        db.ShoppingListItems.Add(item);
        list!.Touch(now);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildListConcurrencyConflictAsync(list, db, ct);
        }

        await liveSync.ShoppingListItemChangedAsync(
            groupId: plan!.GroupId,
            planId: plan.Id,
            listId: list.Id,
            itemId: item.Id,
            action: LiveSyncAction.Created,
            ct: ct);

        return Results.Created(
            $"/api/shopping-lists/{list.Id}/items/{item.Id}",
            ToDto(item));
    }

    // ── PATCH /api/shopping-lists/{listId}/items/{itemId} ──────────

    private static async Task<IResult> PatchItemAsync(
        Guid listId,
        Guid itemId,
        HttpRequest request,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (list, plan, err) = await LoadListWithMembershipAsync(db, listId, userId, ct);
        if (err is not null) return err;

        // OFF3: PATCH targets a single item but we bump list.Version on
        // every mutation. Match against the list so the client's single
        // ETag per shopping-list query stays the authoritative token.
        var listConflict = await BuildListConflictIfMismatchAsync(request, list!, db, ct);
        if (listConflict is not null) return listConflict;

        var item = await db.ShoppingListItems
            .FirstOrDefaultAsync(i => i.Id == itemId, ct);
        if (item is null || item.ShoppingListId != list!.Id)
            return FamilienResults.NotFound(
                ErrorCodes.ShoppingItemNotFound,
                "Shopping list item not found.");

        ItemPatchRequest patch;
        try
        {
            patch = await ItemPatchRequest.ReadAsync(request, ct);
        }
        catch (JsonException)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid shopping list payload.");
        }

        var now = clock.GetUtcNow();

        try
        {
            if (patch.IsChecked.HasValue)
            {
                var e = patch.IsChecked.Value;
                if (e.ValueKind != JsonValueKind.True && e.ValueKind != JsonValueKind.False)
                    return FamilienResults.BadRequest(
                        ErrorCodes.InvalidValue,
                        "Field 'isChecked' must be true or false.",
                        fieldName: "isChecked");
                item.SetChecked(e.GetBoolean(), now);
            }
            if (patch.Note.HasValue)
            {
                var e = patch.Note.Value;
                if (e.ValueKind == JsonValueKind.Null) item.SetNote(null, now);
                else if (e.ValueKind == JsonValueKind.String) item.SetNote(e.GetString(), now);
                else
                    return FamilienResults.BadRequest(
                        ErrorCodes.InvalidValue,
                        "Field 'note' must be a string or null.",
                        fieldName: "note");
            }
        }
        catch (ArgumentException)
        {
            return FamilienResults.BadRequest(
                ErrorCodes.InvalidInput, "Invalid shopping list payload.");
        }

        list!.Touch(now);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildListConcurrencyConflictAsync(list, db, ct);
        }

        await liveSync.ShoppingListItemChangedAsync(
            groupId: plan!.GroupId,
            planId: plan.Id,
            listId: list.Id,
            itemId: item.Id,
            action: LiveSyncAction.Updated,
            ct: ct);

        return Results.Ok(ToDto(item));
    }

    // ── DELETE /api/shopping-lists/{listId}/items/{itemId} ─────────

    private static async Task<IResult> DeleteItemAsync(
        Guid listId,
        Guid itemId,
        HttpRequest httpRequest,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        ILiveSyncPublisher liveSync,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId)) return Results.Unauthorized();

        var (list, plan, err) = await LoadListWithMembershipAsync(db, listId, userId, ct);
        if (err is not null) return err;

        // OFF3: list.Version is the concurrency token.
        var listConflict = await BuildListConflictIfMismatchAsync(httpRequest, list!, db, ct);
        if (listConflict is not null) return listConflict;

        var item = await db.ShoppingListItems
            .FirstOrDefaultAsync(i => i.Id == itemId, ct);
        if (item is null || item.ShoppingListId != list!.Id)
            return FamilienResults.NotFound(
                ErrorCodes.ShoppingItemNotFound,
                "Shopping list item not found.");

        db.ShoppingListItems.Remove(item);
        list!.Touch(clock.GetUtcNow());
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return await BuildListConcurrencyConflictAsync(list, db, ct);
        }

        await liveSync.ShoppingListItemChangedAsync(
            groupId: plan!.GroupId,
            planId: plan.Id,
            listId: list.Id,
            itemId: itemId,
            action: LiveSyncAction.Deleted,
            ct: ct);

        return Results.NoContent();
    }
}
