/**
 * COOK-2 — ingredient-highlight helper.
 *
 * Given a step-text and the recipe's ingredient list, returns one match
 * record per occurrence of an ingredient name inside the step. Used by
 * `tokeniseStepText` to render ingredient-chips inline next to the
 * `TimerChip` matches from `extractTimers`.
 *
 * Matching rules:
 * - Case-insensitive substring search on each ingredient's `name`.
 * - Word-boundary required on both sides (`\b`) so short names don't
 *   match inside unrelated words.
 * - Names of length ≤ 2 are skipped (too noisy).
 * - When two ingredients match at the same position, prefer the LONGER
 *   name — it's the more specific one.
 *
 * The returned `text` field is the EXACT slice of the step text — i.e.
 * it preserves the caller's casing so the chip renders the text the
 * user actually wrote. `matchStart` / `matchEnd` use half-open indices
 * into the original `stepText` string.
 */
export interface IngredientMatch {
  matchStart: number
  matchEnd: number
  text: string
  ingredientId: string
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function matchIngredientsInStep(
  stepText: string,
  ingredients: Array<{ id: string; name: string }>,
): IngredientMatch[] {
  if (!stepText || ingredients.length === 0) return []

  const candidates: IngredientMatch[] = []
  for (const ingredient of ingredients) {
    const name = ingredient.name
    if (!name || name.length <= 2) continue
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi')
    let execResult: RegExpExecArray | null = null
    while ((execResult = pattern.exec(stepText)) !== null) {
      const matchStart = execResult.index
      const matchEnd = matchStart + execResult[0].length
      candidates.push({
        matchStart,
        matchEnd,
        text: stepText.slice(matchStart, matchEnd),
        ingredientId: ingredient.id,
      })
    }
  }

  // Overlap resolution: when two candidates overlap, keep the LONGER
  // one. Sort by matchStart asc, length desc — then walk greedily and
  // skip any candidate that overlaps a previously-accepted longer one.
  candidates.sort((a, b) => {
    if (a.matchStart !== b.matchStart) return a.matchStart - b.matchStart
    return b.matchEnd - b.matchStart - (a.matchEnd - a.matchStart)
  })

  const accepted: IngredientMatch[] = []
  for (const candidate of candidates) {
    const overlapping = accepted.find(
      (prev) =>
        candidate.matchStart < prev.matchEnd &&
        candidate.matchEnd > prev.matchStart,
    )
    if (overlapping) {
      const overlapLen = overlapping.matchEnd - overlapping.matchStart
      const candidateLen = candidate.matchEnd - candidate.matchStart
      if (candidateLen > overlapLen) {
        accepted.splice(accepted.indexOf(overlapping), 1, candidate)
      }
      continue
    }
    accepted.push(candidate)
  }

  return accepted.sort((a, b) => a.matchStart - b.matchStart)
}
