import { extractTimers } from './extractTimers'
import { matchIngredientsInStep } from './matchIngredientsInStep'

/**
 * COOK-2 — unified token stream for a cook-step.
 *
 * Merges the timer-match list from `extractTimers` and the ingredient-
 * match list from `matchIngredientsInStep` into a single linear stream
 * of `text` / `timer` / `ingredient` tokens. The CookStepCard renders
 * each token with its respective component (span / TimerChip /
 * IngredientChip) without having to tokenise the string twice.
 *
 * Overlap rule: timers WIN over ingredients. A timer match is always
 * more actionable ("tap to start countdown") than an ingredient
 * highlight ("tap to scroll to list"). If an ingredient match falls
 * fully inside — or even partly overlaps — a timer match, we drop the
 * ingredient.
 *
 * Empty-text suppression: we never emit `{ type: 'text', value: '' }`
 * tokens. Two adjacent chips stay adjacent; a chip at position 0 has
 * no leading text token; a chip at the end has no trailing text token.
 */
export type StepToken =
  | { type: 'text'; value: string }
  | { type: 'timer'; label: string; seconds: number; key: string }
  | { type: 'ingredient'; text: string; ingredientId: string; key: string }

interface Span {
  start: number
  end: number
  kind: 'timer' | 'ingredient'
  payload: StepToken
}

export function tokeniseStepText(
  stepText: string,
  ingredients: Array<{ id: string; name: string }>,
): StepToken[] {
  if (!stepText) return []

  const timers = extractTimers(stepText)
  const ingredientMatches = matchIngredientsInStep(stepText, ingredients)

  const timerSpans: Span[] = timers.map((t) => ({
    start: t.matchStart,
    end: t.matchEnd,
    kind: 'timer',
    payload: {
      type: 'timer',
      label: t.label,
      seconds: t.seconds,
      key: `timer:${t.matchStart}:${t.seconds}`,
    },
  }))

  // Drop any ingredient match that overlaps a timer match at all.
  const filteredIngredients = ingredientMatches.filter((ingredient) => {
    return !timerSpans.some(
      (timer) =>
        ingredient.matchStart < timer.end && ingredient.matchEnd > timer.start,
    )
  })

  const ingredientSpans: Span[] = filteredIngredients.map((m) => ({
    start: m.matchStart,
    end: m.matchEnd,
    kind: 'ingredient',
    payload: {
      type: 'ingredient',
      text: m.text,
      ingredientId: m.ingredientId,
      key: `ingredient:${m.matchStart}:${m.ingredientId}`,
    },
  }))

  const spans = [...timerSpans, ...ingredientSpans].sort(
    (a, b) => a.start - b.start,
  )

  const tokens: StepToken[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) {
      tokens.push({ type: 'text', value: stepText.slice(cursor, span.start) })
    }
    tokens.push(span.payload)
    cursor = span.end
  }
  if (cursor < stepText.length) {
    tokens.push({ type: 'text', value: stepText.slice(cursor) })
  }

  return tokens
}
