using System.Globalization;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using FamilienKochbuch.Domain.MealPlanning;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// P3-5 aggregator. Takes a <see cref="MealPlan"/> (with its slots +
/// each slot's <see cref="Recipe"/> + <see cref="Ingredient"/> graph
/// eager-loaded) and flattens it into a de-duplicated list of
/// <see cref="ComputedShoppingItem"/> rows ready to upsert into
/// <see cref="ShoppingListItem"/>.
///
/// Algorithm (plan §P3-5):
/// <list type="number">
///   <item>Skip every <see cref="MealPlanSlot"/> with
///     <see cref="MealPlanSlot.ParentSlotId"/> set — those are
///     meal-prep leftovers whose ingredients are already covered by
///     the parent slot. Double-counting them would push the user to
///     buy 3× the tomatoes for Monday + Tuesday + Wednesday
///     reheats.</item>
///   <item>Skip freeform-label slots (no <see cref="MealPlanSlot.RecipeId"/>)
///     — they don't have ingredients.</item>
///   <item>For each remaining slot with a recipe: scale every
///     ingredient's quantity by
///     <c>slot.Servings / recipe.DefaultServings</c>.</item>
///   <item>Merge by (name.ToLowerInvariant(), unit.ToLowerInvariant()):
///     sum numeric quantities, preserve the unit of the first
///     occurrence, append a " + X" note when a non-numeric quantity
///     clashes with a numeric one (we never guess unit
///     conversions).</item>
///   <item>Carryover merge (only on first-time generate, not
///     regenerates): add previous-week items whose
///     <see cref="ShoppingListItem.IsChecked"/> is false AND
///     <see cref="ShoppingListItem.Source"/> is not
///     <see cref="ShoppingListItemSource.Manual"/>. Tagged with
///     <see cref="ShoppingListItemSource.CarriedOver"/> +
///     <c>CarriedOverFromPreviousWeek=true</c>.</item>
///   <item>Sort by <see cref="IngredientCategory"/> (name, invariant
///     culture) then by item name; assign <c>SortOrder</c> values
///     0, 10, 20… within each category so UI reordering has
///     headroom without collisions.</item>
/// </list>
/// </summary>
public static class ShoppingListGenerator
{
    /// <summary>
    /// Computed row returned by the generator — does not yet hold a
    /// <see cref="ShoppingListItem.ShoppingListId"/>; the endpoint
    /// wires that in when it persists.
    /// </summary>
    public sealed record ComputedShoppingItem(
        string Name,
        string? Quantity,
        string? Unit,
        string? Note,
        IngredientCategory Category,
        ShoppingListItemSource Source,
        int SortOrder,
        bool CarriedOverFromPreviousWeek);

    /// <summary>
    /// Snapshot of a previous-week item used by the carryover merge.
    /// Kept as a plain record so the generator doesn't take a
    /// dependency on the mutable entity type.
    /// </summary>
    public sealed record CarryoverCandidate(
        string Name,
        string? Quantity,
        string? Unit,
        string? Note,
        IngredientCategory Category,
        ShoppingListItemSource Source,
        bool IsChecked);

    public static IReadOnlyList<ComputedShoppingItem> Generate(
        MealPlan plan,
        IReadOnlyDictionary<Guid, Recipe> recipesById,
        IReadOnlyCollection<CarryoverCandidate>? carryoverCandidates = null)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(recipesById);

        // ── Step 1+2+3: aggregate non-leftover, recipe-bound slots ──
        // Merge key is (lower-cased name, lower-cased unit) so unit
        // clashes (g vs kg) produce two rows and the UI shows both.
        var agg = new Dictionary<MergeKey, AggregatedItem>();

        foreach (var slot in plan.Slots)
        {
            if (slot.ParentSlotId is not null) continue;     // leftover — skip
            if (slot.RecipeId is null) continue;             // freeform label — skip
            if (!recipesById.TryGetValue(slot.RecipeId.Value, out var recipe)) continue;
            if (recipe.DefaultServings <= 0) continue;       // defensive — ctor enforces >0

            var scale = (decimal)slot.Servings / recipe.DefaultServings;

            foreach (var ing in recipe.Ingredients)
            {
                MergeInto(agg, BuildFromIngredient(ing, scale));
            }
        }

        // ── Step 5: carryover merge (only when requested) ──────────
        if (carryoverCandidates is not null)
        {
            foreach (var cand in carryoverCandidates)
            {
                if (cand.IsChecked) continue;
                if (cand.Source == ShoppingListItemSource.Manual) continue;
                MergeInto(agg, BuildFromCarryover(cand));
            }
        }

        // ── Step 6: sort + assign SortOrder ────────────────────────
        // Category bucket first (string form for deterministic
        // alphabetic order — P3-6 will replace this with a natural
        // supermarket-aisle order), then by name with the invariant-
        // culture IgnoreCase comparer so "Äpfel" sorts next to
        // "Apfel".
        var grouped = agg.Values
            .GroupBy(a => a.Category)
            .OrderBy(g => g.Key.ToString(), StringComparer.InvariantCultureIgnoreCase)
            .ToList();

        var result = new List<ComputedShoppingItem>(agg.Count);
        foreach (var bucket in grouped)
        {
            var ordered = bucket.OrderBy(a => a.Name, StringComparer.InvariantCultureIgnoreCase).ToList();
            for (var i = 0; i < ordered.Count; i++)
            {
                var item = ordered[i];
                result.Add(new ComputedShoppingItem(
                    Name: item.Name,
                    Quantity: item.QuantityString,
                    Unit: item.Unit,
                    Note: item.Note,
                    Category: item.Category,
                    Source: item.Source,
                    SortOrder: i * 10,
                    CarriedOverFromPreviousWeek: item.CarriedOver));
            }
        }

        return result;
    }

    // ── Internals ──────────────────────────────────────────────────

    private readonly record struct MergeKey(string Name, string Unit);

    private sealed class AggregatedItem
    {
        public required string Name { get; init; }
        public string? Unit { get; set; }
        public decimal? NumericQuantity { get; set; }
        public string? FreeformQuantity { get; set; }
        public string? Note { get; set; }
        public IngredientCategory Category { get; set; }
        public ShoppingListItemSource Source { get; set; }
        public bool CarriedOver { get; set; }

        /// <summary>
        /// Serialized quantity — prefers the numeric bucket formatted
        /// with the invariant culture; falls back to the freeform
        /// string. Returns null if neither is set (rare but possible
        /// for "nach Geschmack"-style ingredients where the recipe
        /// author left Quantity null).
        /// </summary>
        public string? QuantityString =>
            NumericQuantity is { } n
                ? FormatNumericQuantity(n)
                : FreeformQuantity;
    }

    private static AggregatedItem BuildFromIngredient(Ingredient ing, decimal scale)
    {
        var trimmedName = ing.Name.Trim();
        var trimmedUnit = string.IsNullOrWhiteSpace(ing.Unit) ? null : ing.Unit.Trim();

        return new AggregatedItem
        {
            Name = trimmedName,
            Unit = trimmedUnit,
            NumericQuantity = ing.Quantity.HasValue ? ing.Quantity.Value * scale : null,
            FreeformQuantity = null,
            Note = string.IsNullOrWhiteSpace(ing.Note) ? null : ing.Note.Trim(),
            // P3-6: run the static categorizer on the raw ingredient
            // name so FromPlan rows land in the right supermarket
            // aisle instead of defaulting to Sonstiges. Unknown names
            // still fall through to Sonstiges; the UI can later ask
            // the user to trigger an LLM recategorize.
            Category = IngredientCategorizer.Categorize(trimmedName),
            Source = ShoppingListItemSource.FromPlan,
            CarriedOver = false,
        };
    }

    private static AggregatedItem BuildFromCarryover(CarryoverCandidate cand)
    {
        var unit = string.IsNullOrWhiteSpace(cand.Unit) ? null : cand.Unit.Trim();

        AggregatedItem item = new()
        {
            Name = cand.Name.Trim(),
            Unit = unit,
            Note = string.IsNullOrWhiteSpace(cand.Note) ? null : cand.Note.Trim(),
            // CarriedOver items keep their original category so the
            // UI doesn't bounce between buckets week-over-week.
            Category = cand.Category,
            Source = ShoppingListItemSource.CarriedOver,
            CarriedOver = true,
        };

        // Try to interpret the quantity string numerically; fall back
        // to freeform if the recipe author stored "eine Prise".
        if (TryParseInvariantDecimal(cand.Quantity, out var numeric))
            item.NumericQuantity = numeric;
        else
            item.FreeformQuantity = cand.Quantity;

        return item;
    }

    private static void MergeInto(
        Dictionary<MergeKey, AggregatedItem> agg,
        AggregatedItem incoming)
    {
        var key = new MergeKey(
            incoming.Name.ToLowerInvariant(),
            (incoming.Unit ?? string.Empty).ToLowerInvariant());

        if (!agg.TryGetValue(key, out var existing))
        {
            agg[key] = incoming;
            return;
        }

        // Unit stays whatever the first occurrence carried (plan
        // §P3-5 step 4).

        // If the existing item is a plain slot-generated row and the
        // incoming one is a carryover that happened to match, keep
        // the CarriedOver flag + Source as "carried over" so the UI
        // can show the ↺ badge. Both-carried-over or both-FromPlan
        // collapse into whatever the first carried.
        if (incoming.CarriedOver && !existing.CarriedOver)
        {
            existing.CarriedOver = true;
            existing.Source = ShoppingListItemSource.CarriedOver;
        }

        // Numeric-only merge path: both sides parse as a decimal, so
        // we can sum them safely (same unit by definition of the
        // merge key).
        if (existing.NumericQuantity is not null && incoming.NumericQuantity is not null)
        {
            MergeNumericInto(existing, incoming);
            return;
        }

        // Everything else goes through the freeform path: preserve
        // the first occurrence's quantity and append the second as a
        // "+ X" note — we can't safely sum "eine Prise" with 200g.
        MergeFreeformInto(existing, incoming);
    }

    /// <summary>
    /// Both sides carry a numeric quantity and share the merge key
    /// (same lower-cased name + unit). Sum them into existing; the
    /// formatted <see cref="AggregatedItem.QuantityString"/> will
    /// pick the new numeric value up automatically.
    /// </summary>
    private static void MergeNumericInto(AggregatedItem existing, AggregatedItem incoming)
    {
        existing.NumericQuantity = existing.NumericQuantity!.Value + incoming.NumericQuantity!.Value;
    }

    /// <summary>
    /// At least one side is freeform (or both empty). Keep the
    /// existing quantity untouched and append the incoming quantity
    /// to the Note as "+ X" so the user still sees it. If neither
    /// side has any quantity yet, prefer whatever the incoming row
    /// brought so at least some measure lands on the list.
    /// </summary>
    private static void MergeFreeformInto(AggregatedItem existing, AggregatedItem incoming)
    {
        // existing numeric + incoming freeform → append freeform as note.
        if (existing.NumericQuantity is not null && incoming.FreeformQuantity is { } iff)
        {
            existing.Note = AppendAdditionalQuantityNote(existing.Note, iff);
            return;
        }

        // existing freeform + incoming numeric → format numeric, append as note.
        if (existing.FreeformQuantity is not null && incoming.NumericQuantity is { } in2)
        {
            existing.Note = AppendAdditionalQuantityNote(existing.Note, FormatNumericQuantity(in2));
            return;
        }

        // existing freeform + incoming freeform → append incoming freeform as note.
        if (existing.FreeformQuantity is not null && incoming.FreeformQuantity is { } iff2)
        {
            existing.Note = AppendAdditionalQuantityNote(existing.Note, iff2);
            return;
        }

        // Neither side had a quantity — prefer incoming so the user
        // at least sees one measure.
        if (existing.NumericQuantity is null && existing.FreeformQuantity is null)
        {
            existing.NumericQuantity = incoming.NumericQuantity;
            existing.FreeformQuantity = incoming.FreeformQuantity;
        }
    }

    /// <summary>
    /// Concatenates a freeform "+ X" fragment onto the existing note,
    /// deduplicating back-to-back regenerates that produce the same
    /// clash, and capping the total length at
    /// <see cref="ShoppingListItem.NoteMaxLength"/> so a long-running
    /// regen loop cannot push the domain constructor past its limit
    /// and throw (would DoS /generate).
    /// </summary>
    private static string AppendAdditionalQuantityNote(string? existingNote, string addition)
    {
        var fragment = $"+ {addition}";
        string candidate;
        if (string.IsNullOrWhiteSpace(existingNote))
        {
            candidate = fragment;
        }
        else if (existingNote.Contains(fragment, StringComparison.Ordinal))
        {
            // Already present — don't grow the note on repeat regens.
            return existingNote;
        }
        else
        {
            candidate = $"{existingNote}; {fragment}";
        }

        return candidate.Length <= ShoppingListItem.NoteMaxLength
            ? candidate
            : candidate[..(ShoppingListItem.NoteMaxLength - 1)] + "…";
    }

    private static bool TryParseInvariantDecimal(string? s, out decimal value)
    {
        value = 0m;
        if (string.IsNullOrWhiteSpace(s)) return false;
        return decimal.TryParse(
            s,
            NumberStyles.Float | NumberStyles.AllowThousands,
            CultureInfo.InvariantCulture,
            out value);
    }

    /// <summary>
    /// Formats a decimal quantity back to a user-friendly string.
    /// Trims trailing zeros so 2.000 → "2" and 1.250 → "1.25". Uses
    /// invariant culture so the wire format never shifts with the
    /// user's locale ("3,5" vs "3.5"). The "0.###############" format
    /// string alone strips trailing zeros — no division trick needed;
    /// attempting one with a 30-digit divisor is a decimal-precision
    /// trap that introduces rounding noise rather than removing it.
    /// 15 fractional digits cover Ingredient.Quantity's numeric(12,3)
    /// precision with headroom for the scaling multiplication.
    /// </summary>
    private static string FormatNumericQuantity(decimal value)
    {
        return value.ToString("0.###############", CultureInfo.InvariantCulture);
    }
}
