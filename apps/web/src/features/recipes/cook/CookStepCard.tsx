import { Fragment, useMemo } from 'react'
import type { RecipeStepDto } from '@familien-kochbuch/shared'
import { renderInlineMarkdown } from '../markdownRenderer'
import { IngredientChip } from './IngredientChip'
import { TimerChip, type TimerChipState } from './TimerChip'
import { tokeniseStepText } from './tokeniseStepText'

export interface CookStepCardProps {
  /** Current step DTO (already sorted by position by the parent). */
  step: RecipeStepDto
  /** 1-based index of this step inside the recipe — shown in the header. */
  stepNumber: number
  /** Total number of steps — shown in the header. */
  totalSteps: number
  /**
   * COOK-1 — lifted timer state map (owned by the CookModePage). Each
   * extracted timer gets a stable key (`${step.id}:${matchStart}`) so
   * the running / paused / done status survives step navigation.
   */
  timerStates: Map<string, TimerChipState>
  onTimerStateChange: (key: string, next: TimerChipState) => void
  /**
   * COOK-2 — recipe ingredient list, used to highlight ingredient
   * names that appear in the step text as tap-able chips. Ids are
   * non-nullable here — the parent narrows the server DTOs (where id
   * is optional for create-payloads) to the always-present runtime
   * shape before passing in.
   */
  ingredients: Array<{ id: string; name: string }>
  /**
   * COOK-2 — called when the user taps an ingredient chip. The parent
   * (CookModePage) uses this to navigate back to Mise-en-Place with
   * the row flashed (`Option A` from the plan).
   */
  onIngredientActivate: (ingredientId: string) => void
}

/**
 * COOK-0 + COOK-1 + COOK-2 Step Card (Step 1..N).
 *
 * Immersive single-step view: oversized serif step number, big-type
 * markdown-rendered body. COOK-1 adds inline TimerChips for every
 * German time expression. COOK-2 adds inline IngredientChips for every
 * ingredient name that appears in the step text. Tokenisation is
 * unified through `tokeniseStepText` so the timer-vs-ingredient
 * overlap is resolved in one place (timers win).
 *
 * Timer state is lifted into the CookModePage via the required
 * `timerStates` / `onTimerStateChange` props so running timers survive
 * step transitions. Ingredient-chip activation bubbles via
 * `onIngredientActivate`.
 *
 * Typography target: 22–26 px body on a 1.55 line-height, 30–38 px
 * heading. `max-w-[52ch]` caps reading width so long steps don't run
 * edge-to-edge on wide tablets/desktops.
 */
export function CookStepCard({
  step,
  stepNumber,
  totalSteps,
  timerStates,
  onTimerStateChange,
  ingredients,
  onIngredientActivate,
}: CookStepCardProps) {
  const tokens = useMemo(
    () => tokeniseStepText(step.content, ingredients),
    [step.content, ingredients],
  )

  const body = useMemo(() => {
    const nodes: React.ReactNode[] = []
    tokens.forEach((token, index) => {
      if (token.type === 'text') {
        nodes.push(
          <Fragment key={`txt-${index}`}>
            {renderInlineMarkdown(token.value)}
          </Fragment>,
        )
        return
      }
      if (token.type === 'timer') {
        const key = `${step.id}:${token.key}`
        nodes.push(
          <TimerChip
            key={`timer-${index}`}
            label={token.label}
            initialSeconds={token.seconds}
            state={timerStates.get(key)}
            onStateChange={(next) => onTimerStateChange(key, next)}
          />,
        )
        return
      }
      if (token.type === 'ingredient') {
        nodes.push(
          <IngredientChip
            key={`ing-${index}`}
            text={token.text}
            ingredientId={token.ingredientId}
            onActivate={onIngredientActivate}
          />,
        )
      }
    })
    return nodes
  }, [
    tokens,
    step.id,
    timerStates,
    onTimerStateChange,
    onIngredientActivate,
  ])

  return (
    <article
      data-testid="cook-step-card"
      aria-labelledby="cook-step-heading"
      className="mx-auto flex w-full max-w-2xl flex-col px-6 py-6 md:px-12"
    >
      <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
        Schritt {stepNumber} von {totalSteps}
      </p>
      <div className="mb-6 flex items-baseline gap-4">
        <span
          aria-hidden="true"
          className="font-serif text-[64px] font-bold leading-none text-[hsl(var(--primary))] md:text-[80px]"
        >
          {stepNumber}
        </span>
        <h2
          id="cook-step-heading"
          className="sr-only"
        >
          Schritt {stepNumber}
        </h2>
      </div>
      <div
        data-testid="cook-step-content"
        className="max-w-[52ch] text-[22px] leading-[1.55] text-foreground [&_strong]:font-semibold [&_strong]:text-[hsl(var(--primary-hover,var(--primary)))] md:text-[24px]"
      >
        {body}
      </div>
    </article>
  )
}
