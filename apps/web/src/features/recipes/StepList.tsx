import { useMemo } from 'react'
import type { RecipeStepDto } from '@shared-cookbook/shared'
import { renderInlineMarkdown } from './markdownRenderer'

export interface StepListProps {
  steps: RecipeStepDto[]
}

/**
 * DS5 numbered step cards. Display `font-serif` (Inter under DS8) step
 * number on the left, Markdown-rendered content on the right. Visual
 * shell mirrors .step-card / .step-num in the recipe-detail mockup.
 *
 * Markdown rendering lives in `markdownRenderer.tsx` so the editor-side
 * preview toggle (UX1-RT) can share the exact same output.
 */
export function StepList({ steps }: StepListProps) {
  const ordered = useMemo(
    () => [...steps].sort((a, b) => a.position - b.position),
    [steps],
  )

  return (
    <div className="flex flex-col gap-3">
      {ordered.map((step, index) => (
        <article
          key={step.id ?? `pos-${step.position}`}
          data-testid="step-card"
          className="grid grid-cols-[auto_1fr] gap-3.5 rounded-[18px] border border-border bg-card px-4 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
        >
          <div
            data-testid="step-number"
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-primary font-serif text-[14px] font-bold leading-none text-primary-foreground"
          >
            {index + 1}
          </div>
          <div
            data-testid="step-content"
            className="text-[15px] leading-[1.55] text-foreground [&_strong]:font-semibold [&_strong]:text-[hsl(var(--primary-hover,var(--primary)))]"
          >
            {renderInlineMarkdown(step.content)}
          </div>
        </article>
      ))}
    </div>
  )
}
