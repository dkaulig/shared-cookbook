using SharedCookbook.Domain.Common;
using SharedCookbook.Domain.Enums;

namespace SharedCookbook.Domain.Entities;

/// <summary>
/// A recipe lives in exactly one <see cref="Group"/>, is authored by a
/// single user, and aggregates ordered <see cref="Ingredients"/>,
/// ordered <see cref="Steps"/>, and a set of <see cref="RecipeTags"/>.
/// PRD §4.1 / §8.3 invariants: title required (1..200), default servings
/// positive, difficulty in 1..3, at most three photos.
///
/// OFF3: implements <see cref="IVersionedEntity"/> so every mutation
/// method bumps a monotonically increasing <see cref="Version"/> used
/// for weak ETags + optimistic-concurrency <c>If-Match</c> checks.
/// </summary>
public class Recipe : IVersionedEntity
{
    public const int TitleMaxLength = 200;
    public const int DescriptionMaxLength = 2000;
    public const int SourceUrlMaxLength = 2000;
    public const int MaxPhotos = 3;
    public const int MinDifficulty = 1;
    public const int MaxDifficulty = 3;

    /// <summary>
    /// LANG-2 — fallback for the <see cref="SourceLanguage"/> ctor
    /// parameter. <c>"de"</c> matches the migration backfill and the
    /// pre-LANG-1 corpus's de-facto language. New production call sites
    /// MUST pass the caller's UI language explicitly; the default exists
    /// so existing tests don't churn for a column they don't exercise.
    /// </summary>
    public const string DefaultSourceLanguage = "de";

    // EF-friendly parameterless ctor — private so domain construction goes
    // through the validating ctor below.
    private Recipe() { }

    public Recipe(
        Guid groupId,
        Guid createdByUserId,
        string title,
        string? description,
        int defaultServings,
        int? prepTimeMinutes,
        int difficulty,
        string? sourceUrl,
        RecipeSourceType sourceType,
        Guid? forkOfRecipeId,
        DateTimeOffset createdAt,
        string sourceLanguage = DefaultSourceLanguage)
    {
        if (groupId == Guid.Empty)
            throw new ArgumentException("GroupId must not be empty.", nameof(groupId));
        if (createdByUserId == Guid.Empty)
            throw new ArgumentException("CreatedByUserId must not be empty.", nameof(createdByUserId));

        var trimmedTitle = ValidateTitle(title);
        var normalizedDescription = ValidateDescription(description);
        ValidateDefaultServings(defaultServings);
        ValidatePrepTime(prepTimeMinutes);
        ValidateDifficulty(difficulty);
        var normalizedSourceUrl = ValidateSourceUrl(sourceUrl);
        var normalizedLanguage = ValidateSourceLanguage(sourceLanguage);

        Id = Guid.NewGuid();
        GroupId = groupId;
        CreatedByUserId = createdByUserId;
        Title = trimmedTitle;
        Description = normalizedDescription;
        DefaultServings = defaultServings;
        PrepTimeMinutes = prepTimeMinutes;
        Difficulty = difficulty;
        SourceUrl = normalizedSourceUrl;
        SourceType = sourceType;
        ForkOfRecipeId = forkOfRecipeId;
        SourceLanguage = normalizedLanguage;
        Version = 0;
        CreatedAt = createdAt;
        UpdatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid GroupId { get; private set; }
    public Guid CreatedByUserId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public int DefaultServings { get; private set; }
    public int? PrepTimeMinutes { get; private set; }
    public int Difficulty { get; private set; }
    public string? SourceUrl { get; private set; }
    public RecipeSourceType SourceType { get; private set; }
    public Guid? ForkOfRecipeId { get; private set; }

    /// <summary>
    /// LANG-2 — two-letter language code (lowercase) of the recipe's
    /// authored content (title, ingredients, steps, etc.). Whitelist
    /// matches <see cref="Services.LanguageNormalizer"/> (<c>"de"</c> /
    /// <c>"en"</c> today). Migration <c>AddRecipeSourceLanguage</c>
    /// backfilled <c>"de"</c> for all pre-LANG-2 rows; new rows MUST set
    /// it from the caller's <c>Accept-Language</c> via the import / create
    /// endpoints.
    ///
    /// The frontend renders the "Auf Englisch anzeigen" /
    /// "Auf Deutsch anzeigen" toggle only when this value differs from the
    /// caller's UI language; the backend defends against
    /// <c>same-language</c> translation requests with the
    /// <c>already_in_language</c> error code.
    /// </summary>
    public string SourceLanguage { get; private set; } = DefaultSourceLanguage;

    /// <summary>Ordered photo URLs. Max 3. Managed via <see cref="AddPhoto"/>
    /// / <see cref="RemovePhoto"/>.</summary>
    public List<string> Photos { get; private set; } = new();

    public DateTimeOffset? LastCookedAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public DateTimeOffset UpdatedAt { get; private set; }
    public DateTimeOffset? DeletedAt { get; private set; }

    /// <summary>
    /// OFF3 optimistic-concurrency token — monotonically increases by
    /// one on every mutation (title/metadata edit, photo change, mark-
    /// cooked, nutrition update, soft-delete). Starts at 0 on a fresh
    /// recipe. Never reset.
    /// </summary>
    public int Version { get; private set; }

    /// <summary>
    /// <see cref="IVersionedEntity.BumpVersion"/>. Called by every
    /// mutation method on the aggregate so a single endpoint invocation
    /// bumps the counter exactly once per state change.
    /// </summary>
    public void BumpVersion() => Version++;

    /// <summary>
    /// Optional LLM-estimated per-portion nutrition (P2-10). ``null``
    /// when no estimate is available. Manage via
    /// <see cref="SetNutritionEstimate"/>.
    /// </summary>
    public NutritionEstimate? NutritionEstimate { get; private set; }

    // ── Aggregated children ─────────────────────────────────────────

    /// <summary>
    /// COMP-0 — sub-recipe grouping. Every ingredient + step belongs to
    /// exactly one <see cref="RecipeComponent"/>; a single-block recipe
    /// carries one default component with <c>Label = null</c> and
    /// <c>Position = 0</c>. Enforced via <see cref="ReplaceComponents"/>
    /// (≥ 1 component, unique positions).
    /// </summary>
    public ICollection<RecipeComponent> Components { get; private set; } = new List<RecipeComponent>();

    public ICollection<Ingredient> Ingredients { get; private set; } = new List<Ingredient>();
    public ICollection<RecipeStep> Steps { get; private set; } = new List<RecipeStep>();
    public ICollection<RecipeTag> RecipeTags { get; private set; } = new List<RecipeTag>();

    // ── Behaviour ──────────────────────────────────────────────────

    /// <summary>Updates mutable metadata. Use server-driven replace semantics
    /// (PUT) in the endpoint layer — this just bundles validation.</summary>
    public void UpdateMetadata(
        string title,
        string? description,
        int defaultServings,
        int? prepTimeMinutes,
        int difficulty,
        string? sourceUrl,
        RecipeSourceType sourceType,
        DateTimeOffset updatedAt)
    {
        var trimmedTitle = ValidateTitle(title);
        var normalizedDescription = ValidateDescription(description);
        ValidateDefaultServings(defaultServings);
        ValidatePrepTime(prepTimeMinutes);
        ValidateDifficulty(difficulty);
        var normalizedSourceUrl = ValidateSourceUrl(sourceUrl);

        Title = trimmedTitle;
        Description = normalizedDescription;
        DefaultServings = defaultServings;
        PrepTimeMinutes = prepTimeMinutes;
        Difficulty = difficulty;
        SourceUrl = normalizedSourceUrl;
        SourceType = sourceType;
        UpdatedAt = updatedAt;
        BumpVersion();
    }

    public void AddPhoto(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("Photo URL must not be blank.", nameof(url));
        if (Photos.Count >= MaxPhotos)
            throw new InvalidOperationException(
                $"A recipe may have at most {MaxPhotos} photos.");

        Photos.Add(url.Trim());
        BumpVersion();
    }

    public bool RemovePhoto(string url)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("Photo URL must not be blank.", nameof(url));

        var removed = Photos.Remove(url.Trim());
        if (removed) BumpVersion();
        return removed;
    }

    public void MarkCooked(DateTimeOffset at)
    {
        LastCookedAt = at;
        BumpVersion();
    }

    public void SoftDelete(DateTimeOffset at)
    {
        DeletedAt = at;
        BumpVersion();
    }

    /// <summary>
    /// Replaces (or clears, when <paramref name="estimate"/> is
    /// <c>null</c>) the per-portion nutrition estimate. P2-10.
    /// </summary>
    public void SetNutritionEstimate(NutritionEstimate? estimate, DateTimeOffset at)
    {
        NutritionEstimate = estimate;
        UpdatedAt = at;
        BumpVersion();
    }

    /// <summary>
    /// COMP-0 — atomically replaces the recipe's component set plus the
    /// ingredients + steps each component owns. Called on create and
    /// update paths (and from <see cref="UpdateFromImport"/>) so the
    /// ≥1-component + unique-position + cross-recipe FK invariants live
    /// in one place.
    ///
    /// <para>
    /// <paramref name="components"/> must be ordered by
    /// <see cref="RecipeComponent.Position"/> and contain:
    /// <list type="bullet">
    /// <item>at least one component,</item>
    /// <item>unique positions across the set,</item>
    /// <item>components whose <see cref="RecipeComponent.RecipeId"/>
    /// matches <see cref="Id"/>,</item>
    /// <item>ingredients/steps whose <see cref="Ingredient.ComponentId"/>
    /// / <see cref="RecipeStep.ComponentId"/> references one of the
    /// components in the set AND whose <see cref="Ingredient.RecipeId"/>
    /// / <see cref="RecipeStep.RecipeId"/> equals <see cref="Id"/>.</item>
    /// </list>
    /// Any violation throws <see cref="ArgumentException"/>.
    /// </para>
    /// </summary>
    public void ReplaceComponents(
        IReadOnlyList<RecipeComponent> components,
        IReadOnlyList<Ingredient> ingredients,
        IReadOnlyList<RecipeStep> steps)
    {
        if (components is null) throw new ArgumentNullException(nameof(components));
        if (ingredients is null) throw new ArgumentNullException(nameof(ingredients));
        if (steps is null) throw new ArgumentNullException(nameof(steps));

        if (components.Count == 0)
            throw new ArgumentException(
                "A recipe must have at least one component.", nameof(components));

        var positions = new HashSet<int>();
        var componentIds = new HashSet<Guid>();
        foreach (var component in components)
        {
            if (component.RecipeId != Id)
                throw new ArgumentException(
                    $"Component {component.Id} does not belong to recipe {Id}.", nameof(components));
            if (!positions.Add(component.Position))
                throw new ArgumentException(
                    $"Duplicate component position {component.Position}.", nameof(components));
            componentIds.Add(component.Id);
        }

        // COMP-0 — ingredient / step positions are 0-based per component,
        // not per recipe (two components can each start at position 0).
        var ingredientPositionsByComponent = new Dictionary<Guid, HashSet<int>>();
        foreach (var ingredient in ingredients)
        {
            if (ingredient.RecipeId != Id)
                throw new ArgumentException(
                    $"Ingredient {ingredient.Id} does not belong to recipe {Id}.", nameof(ingredients));
            if (!componentIds.Contains(ingredient.ComponentId))
                throw new ArgumentException(
                    $"Ingredient {ingredient.Id} references unknown component {ingredient.ComponentId}.",
                    nameof(ingredients));
            if (!ingredientPositionsByComponent.TryGetValue(ingredient.ComponentId, out var positionsForComponent))
            {
                positionsForComponent = new HashSet<int>();
                ingredientPositionsByComponent[ingredient.ComponentId] = positionsForComponent;
            }
            if (!positionsForComponent.Add(ingredient.Position))
                throw new ArgumentException(
                    $"Duplicate ingredient position {ingredient.Position} within component {ingredient.ComponentId}.",
                    nameof(ingredients));
        }

        var stepPositionsByComponent = new Dictionary<Guid, HashSet<int>>();
        foreach (var step in steps)
        {
            if (step.RecipeId != Id)
                throw new ArgumentException(
                    $"Step {step.Id} does not belong to recipe {Id}.", nameof(steps));
            if (!componentIds.Contains(step.ComponentId))
                throw new ArgumentException(
                    $"Step {step.Id} references unknown component {step.ComponentId}.",
                    nameof(steps));
            if (!stepPositionsByComponent.TryGetValue(step.ComponentId, out var positionsForComponent))
            {
                positionsForComponent = new HashSet<int>();
                stepPositionsByComponent[step.ComponentId] = positionsForComponent;
            }
            if (!positionsForComponent.Add(step.Position))
                throw new ArgumentException(
                    $"Duplicate step position {step.Position} within component {step.ComponentId}.",
                    nameof(steps));
        }

        Components.Clear();
        foreach (var component in components)
            Components.Add(component);

        Ingredients.Clear();
        foreach (var ingredient in ingredients)
            Ingredients.Add(ingredient);

        Steps.Clear();
        foreach (var step in steps)
            Steps.Add(step);
    }

    /// <summary>
    /// REIMPORT-0 — overwrites the recipe's mutable body with a fresh
    /// extraction result. Preserves identity (<see cref="Id"/>, <see cref="GroupId"/>,
    /// <see cref="CreatedAt"/>, <see cref="CreatedByUserId"/>), user-owned
    /// artefacts (<see cref="Photos"/>, <see cref="LastCookedAt"/>,
    /// ratings, meal-plan slot assignments) and user-curated custom tags;
    /// replaces metadata, ingredients, steps, AI tags and the nutrition
    /// estimate in-place.
    ///
    /// <para>
    /// Tag merge rule: entries in <see cref="RecipeTags"/> that resolve
    /// against <paramref name="existingAndNewTags"/> to a tag with
    /// <see cref="TagCategory.Custom"/> stay on the recipe. Every other
    /// existing tag link is dropped. For each name in
    /// <paramref name="newAiTagNames"/> we look up the matching Tag in
    /// <paramref name="existingAndNewTags"/> (case-insensitive), skip it
    /// when a preserved custom tag already carries that name ("custom
    /// wins"), and otherwise append a fresh <see cref="RecipeTag"/> link.
    /// Duplicate names inside the AI list collapse to one row.
    /// </para>
    ///
    /// <para>
    /// The caller is responsible for having already loaded the <see cref="Ingredients"/>
    /// / <see cref="Steps"/> / <see cref="RecipeTags"/> collections and
    /// staged fresh child rows (<paramref name="newIngredients"/> /
    /// <paramref name="newSteps"/>) against this recipe's id. EF cascade-
    /// delete sweeps the detached old rows when the context is saved.
    /// Bumps <see cref="Version"/> exactly once.
    /// </para>
    ///
    /// <para>
    /// <paramref name="cookTimeMinutes"/> is accepted for future
    /// forward-compatibility with extractor results that split prep +
    /// cook; the current entity has no dedicated column for it. REIMPORT-0
    /// deliberately ignores the value rather than folding it into
    /// <see cref="PrepTimeMinutes"/> behind the user's back — a later
    /// schema slice will introduce the column and the flow can thread
    /// the value through.
    /// </para>
    /// </summary>
    public void UpdateFromImport(
        string title,
        string? description,
        int? defaultServings,
        int? prepTimeMinutes,
        int? cookTimeMinutes,
        int? difficulty,
        IReadOnlyList<RecipeComponent> newComponents,
        IReadOnlyList<Ingredient> newIngredients,
        IReadOnlyList<RecipeStep> newSteps,
        IReadOnlyList<string> newAiTagNames,
        IReadOnlyList<Tag> existingAndNewTags,
        NutritionEstimate? nutrition,
        DateTimeOffset now)
    {
        if (newComponents is null) throw new ArgumentNullException(nameof(newComponents));
        if (newIngredients is null) throw new ArgumentNullException(nameof(newIngredients));
        if (newSteps is null) throw new ArgumentNullException(nameof(newSteps));
        if (newAiTagNames is null) throw new ArgumentNullException(nameof(newAiTagNames));
        if (existingAndNewTags is null) throw new ArgumentNullException(nameof(existingAndNewTags));

        // Domain validations mirror the create-time ctor. An extractor
        // that drifts out of these bounds is caller's problem — surfaced
        // as an ArgumentException for the endpoint to translate.
        var trimmedTitle = ValidateTitle(title);
        var normalizedDescription = ValidateDescription(description);
        var servings = defaultServings ?? DefaultServings;
        ValidateDefaultServings(servings);
        ValidatePrepTime(prepTimeMinutes);
        var diff = difficulty ?? Difficulty;
        ValidateDifficulty(diff);
        _ = cookTimeMinutes; // forward-compat placeholder — see xmldoc.

        Title = trimmedTitle;
        Description = normalizedDescription;
        DefaultServings = servings;
        PrepTimeMinutes = prepTimeMinutes;
        Difficulty = diff;
        NutritionEstimate = nutrition;

        // Children: clear-and-add through the shared invariant-enforcer
        // so the ≥1-component + unique-position + component-FK rules
        // apply symmetrically to create and reimport. EF tracks the
        // removals so a subsequent SaveChanges issues DELETEs for the
        // old rows via the recipe's cascade-FK config.
        ReplaceComponents(newComponents, newIngredients, newSteps);

        // Tag merge — see xmldoc above. We split existingAndNewTags into
        // a lookup by Id and a lookup by normalized name so the decision
        // per RecipeTag / AI-name is O(1).
        var tagById = new Dictionary<Guid, Tag>();
        foreach (var tag in existingAndNewTags)
        {
            // Last writer wins on duplicate ids — callers should not
            // hand in duplicate Tag instances, but we don't blow up.
            tagById[tag.Id] = tag;
        }

        // Preserve the ids of existing Custom tags on the recipe. Every
        // RecipeTag whose Tag is either non-Custom or unknown to the
        // lookup is dropped.
        var preservedTagIds = new HashSet<Guid>();
        var preservedCustomNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var rt in RecipeTags)
        {
            if (tagById.TryGetValue(rt.TagId, out var tag) && tag.Category == TagCategory.Custom)
            {
                preservedTagIds.Add(rt.TagId);
                preservedCustomNames.Add(tag.Name);
            }
        }

        // Index AI-candidate tags by normalized name — we match on the
        // lower-cased trimmed form so "vegetarisch" against a seeded
        // "Vegetarisch" tag still resolves.
        var tagByName = new Dictionary<string, Tag>(StringComparer.OrdinalIgnoreCase);
        foreach (var tag in existingAndNewTags)
        {
            // Don't index Custom tags under the AI-name map — Custom-wins
            // is enforced explicitly below via preservedCustomNames.
            if (tag.Category == TagCategory.Custom) continue;
            tagByName.TryAdd(tag.Name.Trim(), tag);
        }

        RecipeTags.Clear();
        foreach (var preservedId in preservedTagIds)
            RecipeTags.Add(new RecipeTag(Id, preservedId));

        // Add new AI tags, honouring the custom-wins rule + intra-list
        // de-dup. AI names are already lower-cased per the method
        // contract; we Trim() defensively.
        var seenAiTagIds = new HashSet<Guid>();
        foreach (var rawName in newAiTagNames)
        {
            if (string.IsNullOrWhiteSpace(rawName)) continue;
            var name = rawName.Trim();
            if (preservedCustomNames.Contains(name)) continue; // Custom wins.
            if (!tagByName.TryGetValue(name, out var aiTag)) continue;
            if (!seenAiTagIds.Add(aiTag.Id)) continue;
            if (preservedTagIds.Contains(aiTag.Id)) continue;
            RecipeTags.Add(new RecipeTag(Id, aiTag.Id));
        }

        UpdatedAt = now;
        BumpVersion();
    }

    // ── Validation helpers ─────────────────────────────────────────

    private static string ValidateTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            throw new ArgumentException("Recipe title must not be blank.", nameof(title));
        var trimmed = title.Trim();
        if (trimmed.Length > TitleMaxLength)
            throw new ArgumentException(
                $"Recipe title must be at most {TitleMaxLength} characters.", nameof(title));
        return trimmed;
    }

    private static string? ValidateDescription(string? description)
    {
        if (string.IsNullOrWhiteSpace(description)) return null;
        var trimmed = description.Trim();
        if (trimmed.Length > DescriptionMaxLength)
            throw new ArgumentException(
                $"Recipe description must be at most {DescriptionMaxLength} characters.", nameof(description));
        return trimmed;
    }

    private static void ValidateDefaultServings(int defaultServings)
    {
        if (defaultServings <= 0)
            throw new ArgumentException(
                "Default servings must be greater than zero.", nameof(defaultServings));
    }

    private static void ValidatePrepTime(int? prepTimeMinutes)
    {
        if (prepTimeMinutes is < 0)
            throw new ArgumentException(
                "Preparation time must not be negative.", nameof(prepTimeMinutes));
    }

    private static void ValidateDifficulty(int difficulty)
    {
        if (difficulty < MinDifficulty || difficulty > MaxDifficulty)
            throw new ArgumentException(
                $"Difficulty must be between {MinDifficulty} and {MaxDifficulty}.", nameof(difficulty));
    }

    /// <summary>
    /// LANG-2 — validate + normalise the source-language code. Returns
    /// the lowercase trimmed value if it matches the
    /// <see cref="Services.LanguageNormalizer"/> whitelist; throws an
    /// <see cref="ArgumentException"/> otherwise. The whitelist is
    /// duplicated here (rather than referenced) so the Domain assembly
    /// stays free of the Api dependency it doesn't otherwise carry.
    /// </summary>
    private static string ValidateSourceLanguage(string sourceLanguage)
    {
        if (string.IsNullOrWhiteSpace(sourceLanguage))
            throw new ArgumentException(
                "Source language must not be blank.", nameof(sourceLanguage));
        var normalized = sourceLanguage.Trim().ToLowerInvariant();
        if (normalized != "de" && normalized != "en")
            throw new ArgumentException(
                "Source language must be one of: de, en.", nameof(sourceLanguage));
        return normalized;
    }

    private static string? ValidateSourceUrl(string? sourceUrl)
    {
        if (string.IsNullOrWhiteSpace(sourceUrl)) return null;
        var trimmed = sourceUrl.Trim();
        if (trimmed.Length > SourceUrlMaxLength)
            throw new ArgumentException(
                $"Source URL must be at most {SourceUrlMaxLength} characters.", nameof(sourceUrl));

        // REIMPORT-0 hardening — defence-in-depth scheme guard at the
        // aggregate boundary. The import endpoint's `TryNormalizeHttpUrl`
        // already rejects non-http(s) at intake, and the reimport
        // endpoint re-checks before handing the value to the Python
        // extractor. But PUT /api/recipes/{id} / POST /api/recipes used
        // to accept any 2000-char string, which let a malicious group
        // member pivot the column to `file://` / `gopher://` /
        // `javascript:` / `ftp://` between the import and the reimport.
        // Rejecting the scheme here guarantees every write path leaves
        // the column http(s)-only, so the column cannot carry a value
        // that redirects the extractor at an internal or exotic target.
        // `null` / blank stays legitimate (manually-created recipes).
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            throw new ArgumentException(
                "Source URL must use the http or https scheme.", nameof(sourceUrl));
        }
        return trimmed;
    }
}
