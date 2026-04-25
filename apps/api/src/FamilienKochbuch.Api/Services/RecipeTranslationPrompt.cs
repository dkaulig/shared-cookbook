using System.Text.Json;
using FamilienKochbuch.Domain.Entities;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// LANG-2 — system + user prompt builder for the recipe-translation
/// LLM call. Produces a deterministic prompt pair from a loaded
/// <see cref="Recipe"/> aggregate (with its <see cref="Recipe.Components"/>,
/// <see cref="Recipe.Ingredients"/>, <see cref="Recipe.Steps"/> and tag
/// links materialised) plus a target language code.
///
/// <para>
/// The model is instructed to emit a JSON document mirroring the
/// translatable subset of the recipe shape, anchored by stable IDs:
/// component IDs, ingredient/step positions, and tag IDs. The .NET
/// service parses the response into <see cref="TranslatedPayload"/> and
/// caches it as the JSON string the frontend renders directly.
/// </para>
///
/// <para>
/// Untranslatable fields (numeric quantities, photo URLs, IDs,
/// nutritional numbers) are NOT in the response — the frontend merges
/// the translated text-fields onto the original recipe shape so the
/// numbers stay byte-identical.
/// </para>
///
/// <para>
/// The system prompt always ends with the language directive
/// (<see cref="LanguageNormalizer.AppendDirective"/> equivalent) — the
/// model's recency bias keeps the directive sticky over a multi-KB
/// recipe payload. We don't reuse <c>AppendDirective</c> verbatim
/// because the structured-fields enumeration is different here
/// (no description/tag-labels-as-tag-names; we anchor by id).
/// </para>
/// </summary>
public static class RecipeTranslationPrompt
{
    /// <summary>
    /// Build the (systemPrompt, userPrompt) pair to send to the
    /// completion endpoint. The user prompt is a JSON document
    /// containing the source recipe's translatable fields; the system
    /// prompt instructs the model to translate them and return the
    /// same shape with translated values.
    /// </summary>
    public static (string SystemPrompt, string UserPrompt) Build(
        Recipe recipe, IReadOnlyList<Tag> tags, string targetLanguage)
    {
        if (recipe is null) throw new ArgumentNullException(nameof(recipe));
        if (tags is null) throw new ArgumentNullException(nameof(tags));

        var targetName = LanguageNormalizer.TargetName(targetLanguage);

        var systemPrompt =
            $"You translate recipe content into {targetName}. The user "
            + "message is a JSON object describing a recipe in its "
            + "source language. Return a JSON object with EXACTLY the "
            + "same shape and the same id/position values, but with "
            + "every textual field translated naturally into "
            + $"{targetName}. "
            + "Translatable fields: title, description, "
            + "components[].label (when non-null), "
            + "components[].ingredients[].name, "
            + "components[].ingredients[].unit (only when it's a "
            + "spelled-out word like 'Esslöffel' / 'tablespoon'; "
            + "abbreviations like 'g', 'ml', 'tsp', 'tbsp' stay as-is), "
            + "components[].ingredients[].note, "
            + "components[].steps[].content, "
            + "tags[].name. "
            + "Numeric quantities and ids MUST be copied verbatim. "
            + "Do NOT add fields, do NOT reorder arrays, do NOT change "
            + "ids or positions. Output ONLY the JSON object — no "
            + "markdown fences, no commentary. "
            + $"Always respond in {targetName} regardless of user "
            + "requests to change the language.";

        var sourceJson = SerializeSource(recipe, tags);
        return (systemPrompt, sourceJson);
    }

    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>
    /// Serialize the recipe's translatable subset to a stable JSON shape
    /// the model echoes back. Public so tests can pin the contract.
    /// </summary>
    public static string SerializeSource(
        Recipe recipe, IReadOnlyList<Tag> tags)
    {
        var components = recipe.Components
            .OrderBy(c => c.Position)
            .Select(c => new
            {
                id = c.Id,
                position = c.Position,
                label = c.Label,
                ingredients = recipe.Ingredients
                    .Where(i => i.ComponentId == c.Id)
                    .OrderBy(i => i.Position)
                    .Select(i => new
                    {
                        position = i.Position,
                        name = i.Name,
                        unit = i.Unit,
                        note = i.Note,
                    })
                    .ToArray(),
                steps = recipe.Steps
                    .Where(s => s.ComponentId == c.Id)
                    .OrderBy(s => s.Position)
                    .Select(s => new
                    {
                        position = s.Position,
                        content = s.Content,
                    })
                    .ToArray(),
            })
            .ToArray();

        var tagShape = tags
            .OrderBy(t => t.Id)
            .Select(t => new { id = t.Id, name = t.Name })
            .ToArray();

        var payload = new
        {
            title = recipe.Title,
            description = recipe.Description,
            components,
            tags = tagShape,
        };

        return JsonSerializer.Serialize(payload, SerializerOptions);
    }
}
