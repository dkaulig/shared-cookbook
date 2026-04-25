import type {
  IngredientDto,
  RecipeComponentDto,
  RecipeDetailDto,
  RecipeStepDto,
  RecipeTranslationPayload,
  TagDto,
} from '@shared-cookbook/shared'

/**
 * LANG-2 — merge a translated text-payload onto a `RecipeDetailDto` so
 * the detail page can render the translated view without a second
 * server fetch.
 *
 * The translation prompt only carries translatable text (title,
 * description, component labels, ingredient name/unit/note, step
 * content, tag names) — numeric quantities, photo URLs, IDs and
 * positions stay byte-identical from the source. Missing keys fall
 * back to the original recipe so a partial / drifted LLM response
 * degrades gracefully (the user sees a mix of original + translated
 * fields rather than a blank page).
 *
 * Anchors:
 * - Components match by `id`.
 * - Ingredients/steps inside a component match by `position`.
 * - Tags match by `id`.
 */
export function applyTranslation(
  recipe: RecipeDetailDto,
  payload: RecipeTranslationPayload,
): RecipeDetailDto {
  // Match by id when available; fall back to position so the
  // single-default-component case (id may be omitted on the wire) still
  // merges. Component ids are stable post-COMP-0 so the id path covers
  // every multi-component recipe.
  const componentById = new Map(
    payload.components.map((c) => [c.id, c]),
  )
  const componentByPosition = new Map(
    payload.components.map((c) => [c.position, c]),
  )

  const translatedComponents: RecipeComponentDto[] = recipe.components.map(
    (component) => {
      const tComponent = (component.id && componentById.get(component.id))
        || componentByPosition.get(component.position)
      if (!tComponent) return component

      const ingredientByPosition = new Map(
        tComponent.ingredients.map((i) => [i.position, i]),
      )
      const stepByPosition = new Map(
        tComponent.steps.map((s) => [s.position, s]),
      )

      const ingredients: IngredientDto[] = component.ingredients.map(
        (ingredient) => {
          const tIngredient = ingredientByPosition.get(ingredient.position)
          if (!tIngredient) return ingredient
          return {
            ...ingredient,
            name: tIngredient.name ?? ingredient.name,
            unit: tIngredient.unit ?? ingredient.unit,
            note: tIngredient.note ?? ingredient.note,
          }
        },
      )

      const steps: RecipeStepDto[] = component.steps.map((step) => {
        const tStep = stepByPosition.get(step.position)
        if (!tStep) return step
        return { ...step, content: tStep.content ?? step.content }
      })

      return {
        ...component,
        label: tComponent.label ?? component.label,
        ingredients,
        steps,
      }
    },
  )

  const tagById = new Map(payload.tags.map((t) => [t.id, t]))
  const tags: TagDto[] = recipe.tags.map((tag) => {
    const tTag = tagById.get(tag.id)
    return tTag ? { ...tag, name: tTag.name } : tag
  })

  return {
    ...recipe,
    title: payload.title ?? recipe.title,
    description: payload.description ?? recipe.description,
    components: translatedComponents,
    tags,
  }
}
