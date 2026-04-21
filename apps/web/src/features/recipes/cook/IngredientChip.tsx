import { cn } from '@/lib/utils'

export interface IngredientChipProps {
  /** Exact text slice from the step the chip represents. */
  text: string
  /** Which ingredient in the recipe this chip points at. */
  ingredientId: string
  /** Called when the user taps / presses the chip. */
  onActivate: (ingredientId: string) => void
}

/**
 * COOK-2 — inline ingredient-highlight chip.
 *
 * Rendered by `CookStepCard` wherever `tokeniseStepText` finds an
 * ingredient-name match inside the step text. Tapping the chip lifts
 * the `onActivate(ingredientId)` event up to `CookModePage`, which
 * navigates the user back to the Mise-en-Place screen (step 0) with
 * the matching row flashed briefly — see the rationale in the plan
 * (`Option A`).
 *
 * Visual: sage-primary pill sized to sit baseline-aligned inside a
 * 22-24 px body line. `cursor-pointer` + ring on hover/focus so the
 * interactive surface is obvious even on desktops.
 *
 * A11y: `role="button"` on a span element (inside a flow of other
 * spans — a `<button>` would break the inline baseline alignment in
 * some browsers). Keyboard: Enter / Space activate; `tabIndex=0` joins
 * the focus order; `aria-label` is German and echoes the matched text.
 */
export function IngredientChip({
  text,
  ingredientId,
  onActivate,
}: IngredientChipProps) {
  function handleKeyDown(event: React.KeyboardEvent<HTMLSpanElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onActivate(ingredientId)
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      data-testid="ingredient-chip"
      data-ingredient-id={ingredientId}
      aria-label={`Zutat ${text} hervorheben`}
      onClick={() => onActivate(ingredientId)}
      onKeyDown={handleKeyDown}
      className={cn(
        'inline-flex items-baseline rounded-full px-2 py-0.5 align-baseline',
        'bg-[hsl(var(--primary)/0.08)] ring-1 ring-[hsl(var(--primary)/0.25)]',
        'text-base font-medium text-[hsl(var(--primary-hover,var(--primary)))]',
        'cursor-pointer transition-colors duration-150',
        'hover:bg-[hsl(var(--primary)/0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]',
      )}
    >
      {text}
    </span>
  )
}
