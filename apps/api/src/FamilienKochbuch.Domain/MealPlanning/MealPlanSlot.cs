namespace FamilienKochbuch.Domain.MealPlanning;

/// <summary>
/// A single entry on a <see cref="MealPlan"/> — either a reference to a
/// <see cref="Entities.Recipe"/> or a free-text label (e.g. "Restaurant",
/// "Reste vom Vortag"). <see cref="ParentSlotId"/> links meal-prep rest
/// servings back to the cooking slot so the shopping-list aggregator (P3-5)
/// doesn't double-count the ingredients.
/// Invariants (plan §Data model / §P3-0):
/// <list type="bullet">
///   <item>Servings in 1..20.</item>
///   <item>Date in [WeekStart, WeekStart+6].</item>
///   <item>Label and RecipeId cannot both be null.</item>
///   <item>Label max 120 chars.</item>
///   <item>ParentSlotId cannot point to self or form a cycle.</item>
///   <item>ParentSlot must belong to the same MealPlan.</item>
/// </list>
/// </summary>
public sealed class MealPlanSlot
{
    public const int LabelMaxLength = 120;
    public const int MinServings = 1;
    public const int MaxServings = 20;

    // EF-friendly parameterless ctor.
    private MealPlanSlot() { }

    public MealPlanSlot(
        Guid mealPlanId,
        DateOnly weekStart,
        DateOnly date,
        MealSlot meal,
        int servings,
        Guid? recipeId,
        string? label,
        int sortOrder,
        DateTimeOffset createdAt)
    {
        if (mealPlanId == Guid.Empty)
            throw new ArgumentException("MealPlanId must not be empty.", nameof(mealPlanId));

        ValidateDateWithinWeek(date, weekStart);
        ValidateServings(servings);
        var normalizedLabel = ValidateLabelOrRecipe(label, recipeId);

        Id = Guid.NewGuid();
        MealPlanId = mealPlanId;
        Date = date;
        Meal = meal;
        Servings = servings;
        RecipeId = recipeId;
        Label = normalizedLabel;
        SortOrder = sortOrder;
        IsCooked = false;
        ParentSlotId = null;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid MealPlanId { get; private set; }
    public DateOnly Date { get; private set; }
    public MealSlot Meal { get; private set; }
    public int Servings { get; private set; }
    public Guid? RecipeId { get; private set; }
    public string? Label { get; private set; }
    public int SortOrder { get; private set; }
    public bool IsCooked { get; private set; }
    public Guid? ParentSlotId { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>
    /// Navigation back to the owning <see cref="MealPlan"/>. Populated by
    /// EF — never set manually from domain code.
    /// </summary>
    public MealPlan? MealPlan { get; private set; }

    /// <summary>Self-referencing navigation to the meal-prep parent.</summary>
    public MealPlanSlot? ParentSlot { get; private set; }

    /// <summary>Child slots that reference this slot as their meal-prep parent.</summary>
    public ICollection<MealPlanSlot> Children { get; private set; } = new List<MealPlanSlot>();

    /// <summary>
    /// Checks whether <paramref name="candidate"/> can become this slot's
    /// parent without violating the acyclicity or same-plan invariants.
    /// Returns false for self-reference, cross-plan references, and cycles.
    /// </summary>
    public bool CanSetParent(MealPlanSlot candidate)
    {
        ArgumentNullException.ThrowIfNull(candidate);

        if (candidate.Id == Id) return false;
        if (candidate.MealPlanId != MealPlanId) return false;

        // Walk the candidate's parent chain tracking visited IDs; if we hit
        // ourselves or a node we've already seen, a cycle would form.
        var visited = new HashSet<Guid> { candidate.Id };
        for (var cursor = candidate.ParentSlot; cursor is not null; cursor = cursor.ParentSlot)
        {
            if (cursor.Id == Id) return false;
            if (!visited.Add(cursor.Id)) return false;
        }
        return true;
    }

    /// <summary>
    /// Attaches this slot to a meal-prep parent. Enforces the
    /// acyclicity + same-plan invariants. Pass <c>null</c> to detach.
    /// Note: cross-plan parent is enforced ONLY here in the domain. The
    /// endpoint layer (P3-1 PATCH) MUST reload the candidate via
    /// <c>.Include(s =&gt; s.MealPlan)</c> and call <see cref="SetParent"/>
    /// — never assign <see cref="ParentSlotId"/> directly on a detached
    /// entity or the guard is bypassed.
    /// </summary>
    public void SetParent(MealPlanSlot? parent, DateTimeOffset at)
    {
        if (parent is null)
        {
            ParentSlot = null;
            ParentSlotId = null;
            UpdatedAt = at;
            return;
        }

        if (!CanSetParent(parent))
            throw new InvalidOperationException(
                "Parent slot must belong to the same MealPlan and must not form a cycle with the current slot.");

        ParentSlot = parent;
        ParentSlotId = parent.Id;
        UpdatedAt = at;
    }

    /// <summary>Marks this slot as cooked/uncooked.</summary>
    public void SetCooked(bool isCooked, DateTimeOffset at)
    {
        IsCooked = isCooked;
        UpdatedAt = at;
    }

    /// <summary>Updates the relative ordering within the same day + meal bucket.</summary>
    public void Reorder(int sortOrder, DateTimeOffset at)
    {
        SortOrder = sortOrder;
        UpdatedAt = at;
    }

    /// <summary>Replaces the servings count. Throws outside 1..20.</summary>
    public void UpdateServings(int servings, DateTimeOffset at)
    {
        ValidateServings(servings);
        Servings = servings;
        UpdatedAt = at;
    }

    /// <summary>
    /// Replaces <see cref="RecipeId"/> — pass <c>null</c> to clear it
    /// (the slot then relies on <see cref="Label"/> alone). Throws when
    /// both ends up null. Used by the P3-1 PATCH endpoint.
    /// </summary>
    public void SetRecipe(Guid? recipeId, DateTimeOffset at)
    {
        if (recipeId is null && string.IsNullOrWhiteSpace(Label))
            throw new ArgumentException(
                "At least one of RecipeId or Label must be provided.", nameof(recipeId));
        RecipeId = recipeId;
        UpdatedAt = at;
    }

    /// <summary>
    /// Replaces <see cref="Label"/>. Pass <c>null</c> or whitespace to
    /// clear it (the slot must still have a <see cref="RecipeId"/>).
    /// Trims + enforces the 120-char limit; throws when both ends up
    /// null. Used by the P3-1 PATCH endpoint.
    /// </summary>
    public void SetLabel(string? label, DateTimeOffset at)
    {
        string? normalized = null;
        if (!string.IsNullOrWhiteSpace(label))
        {
            normalized = label.Trim();
            if (normalized.Length > LabelMaxLength)
                throw new ArgumentException(
                    $"Label must be at most {LabelMaxLength} characters.", nameof(label));
        }
        if (normalized is null && RecipeId is null)
            throw new ArgumentException(
                "At least one of RecipeId or Label must be provided.", nameof(label));
        Label = normalized;
        UpdatedAt = at;
    }

    // ── Validation helpers ────────────────────────────────────────────

    private static void ValidateDateWithinWeek(DateOnly date, DateOnly weekStart)
    {
        var weekEnd = weekStart.AddDays(6);
        if (date < weekStart || date > weekEnd)
            throw new ArgumentOutOfRangeException(
                nameof(date),
                $"Date {date:O} must lie within the week {weekStart:O}..{weekEnd:O}.");
    }

    private static void ValidateServings(int servings)
    {
        if (servings < MinServings || servings > MaxServings)
            throw new ArgumentOutOfRangeException(
                nameof(servings),
                $"Servings must be between {MinServings} and {MaxServings}.");
    }

    private static string? ValidateLabelOrRecipe(string? label, Guid? recipeId)
    {
        string? normalized = null;
        if (!string.IsNullOrWhiteSpace(label))
        {
            normalized = label.Trim();
            if (normalized.Length > LabelMaxLength)
                throw new ArgumentException(
                    $"Label must be at most {LabelMaxLength} characters.", nameof(label));
        }

        if (normalized is null && recipeId is null)
            throw new ArgumentException(
                "At least one of RecipeId or Label must be provided.", nameof(label));

        return normalized;
    }
}
