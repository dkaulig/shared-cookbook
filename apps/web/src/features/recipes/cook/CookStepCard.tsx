import { Fragment, useMemo } from 'react'
import type { RecipeStepDto } from '@familien-kochbuch/shared'
import { renderInlineMarkdown } from '../markdownRenderer'
import { extractTimers } from './extractTimers'
import { TimerChip, type TimerChipState } from './TimerChip'

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
   * the running / paused / done status survives step navigation. If
   * omitted the chips fall back to uncontrolled mode (useful for
   * one-off component tests).
   */
  timerStates?: Map<string, TimerChipState>
  onTimerStateChange?: (key: string, next: TimerChipState) => void
}

/**
 * COOK-0 + COOK-1 Step Card (Step 1..N).
 *
 * Immersive single-step view: oversized serif step number, big-type
 * markdown-rendered body. COOK-1 adds inline TimerChips at every
 * German time expression the `extractTimers` helper finds. Timer
 * state is lifted into the CookModePage via the optional
 * `timerStates` / `onTimerStateChange` props so running timers
 * survive step-transitions.
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
}: CookStepCardProps) {
  const timers = useMemo(() => extractTimers(step.content), [step.content])

  // Build a ordered token list of text slices + timer chips. When no
  // timers were found we just delegate to the existing inline-Markdown
  // renderer for 1-to-1 parity with COOK-0.
  const body = useMemo(() => {
    if (timers.length === 0) {
      return renderInlineMarkdown(step.content)
    }
    const nodes: React.ReactNode[] = []
    let cursor = 0
    timers.forEach((timer, index) => {
      if (timer.matchStart > cursor) {
        const textSlice = step.content.slice(cursor, timer.matchStart)
        nodes.push(
          <Fragment key={`t-${index}-text`}>
            {renderInlineMarkdown(textSlice)}
          </Fragment>,
        )
      }
      const key = `${step.id}:${timer.matchStart}`
      const existing = timerStates?.get(key)
      const handleStateChange = onTimerStateChange
        ? (next: TimerChipState) => onTimerStateChange(key, next)
        : undefined
      nodes.push(
        <TimerChip
          key={`t-${index}-chip`}
          label={timer.label}
          initialSeconds={timer.seconds}
          state={existing}
          onStateChange={handleStateChange}
        />,
      )
      cursor = timer.matchEnd
    })
    if (cursor < step.content.length) {
      const rest = step.content.slice(cursor)
      nodes.push(
        <Fragment key="t-tail">{renderInlineMarkdown(rest)}</Fragment>,
      )
    }
    return nodes
  }, [step.content, step.id, timers, timerStates, onTimerStateChange])

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
