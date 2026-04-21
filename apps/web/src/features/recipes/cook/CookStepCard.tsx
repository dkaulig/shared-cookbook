import type { RecipeStepDto } from '@familien-kochbuch/shared'
import { renderInlineMarkdown } from '../markdownRenderer'

export interface CookStepCardProps {
  /** Current step DTO (already sorted by position by the parent). */
  step: RecipeStepDto
  /** 1-based index of this step inside the recipe — shown in the header. */
  stepNumber: number
  /** Total number of steps — shown in the header. */
  totalSteps: number
}

/**
 * COOK-0 Step Card (Step 1..N).
 *
 * Immersive single-step view: oversized serif step number, big-type
 * markdown-rendered body. No timers, no ingredient-highlight chips —
 * those land in COOK-1 / COOK-2.
 *
 * Typography target: 22–26 px body on a 1.55 line-height, 30–38 px
 * heading. `max-w-[52ch]` caps reading width so long steps don't run
 * edge-to-edge on wide tablets/desktops.
 */
export function CookStepCard({ step, stepNumber, totalSteps }: CookStepCardProps) {
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
        {renderInlineMarkdown(step.content)}
      </div>
    </article>
  )
}
