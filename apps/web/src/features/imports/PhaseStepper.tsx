import { AlertCircle, Check } from 'lucide-react'
import type { RecipeImportPhase } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/useIsMobile'
import { phaseLabel, phaseOrder, stepperPhases } from './phaseProgress'

interface PhaseStepperProps {
  currentPhase: RecipeImportPhase
  /** 0–100 within-phase progress, drives the mobile-collapsed bar. */
  phaseProgress: number
  /** Import source determines whether slot 2 reads Transcribing or Foto-Analyse. */
  source?: 'url' | 'photos'
  /**
   * Phase the pipeline was running when `currentPhase === 'error'`
   * arrived. The component places an error marker on this slot so the
   * user sees WHERE in the flow the run failed. Optional — falls back
   * to a generic "first in-progress slot" marker when absent.
   */
  attemptedPhase?: RecipeImportPhase
}

/**
 * PV3 — 5-step horizontal breadcrumb: Queued → Downloading → (Transcribing
 * ‖ Foto-Analyse) → Structuring → PostProcessing. Past steps show a
 * check icon + muted treatment; the current step gets the primary
 * highlight; pending steps stay grey.
 *
 * On mobile viewports the stepper collapses to a single line
 * ("Schritt N von 5: Transkription") + a slim progress bar tracking
 * the within-phase percentage — the full breadcrumb is too cramped
 * below 400px and the collapsed version keeps the user oriented
 * without horizontal scroll.
 *
 * Error + Done phases don't re-order the stepper; the parent page
 * swaps the detail card for success/error banners instead, so here we
 * simply map them to the final slot via {@link phaseOrder}.
 */
export function PhaseStepper({
  currentPhase,
  phaseProgress,
  source = 'url',
  attemptedPhase,
}: PhaseStepperProps) {
  const isMobile = useIsMobile()
  const phases = stepperPhases(source)
  const currentIndex = phaseOrder(currentPhase)
  const isDone = currentPhase === 'done'
  const isError = currentPhase === 'error'
  // For error rendering: point the error-marker at the phase the
  // pipeline was attempting when it failed. Fallback to the first slot
  // so the marker still has somewhere to sit on malformed input.
  const errorIndex = isError
    ? (() => {
        if (!attemptedPhase || attemptedPhase === 'error' || attemptedPhase === 'done') {
          return 0
        }
        const idx = phaseOrder(attemptedPhase)
        return idx >= 0 && idx < phases.length ? idx : 0
      })()
    : -1

  if (isMobile) {
    const totalSteps = phases.length
    // `done` maps past-last; clamp back so the "Schritt N/5" label
    // reads "5 von 5" rather than "6 von 5".
    const stepIndex = isError
      ? Math.max(0, errorIndex)
      : Math.min(Math.max(0, currentIndex), totalSteps - 1)
    const clampedPhaseProgress = Math.max(0, Math.min(100, Math.round(phaseProgress)))
    return (
      <section
        data-testid="phase-stepper-mobile"
        aria-label="Import-Schritte"
        className="rounded-[14px] border border-border bg-card px-4 py-3 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
      >
        <p className="text-[13px] font-medium text-foreground">
          Schritt {stepIndex + 1} von {totalSteps}: {phaseLabel(currentPhase)}
        </p>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clampedPhaseProgress}
          aria-label="Phasen-Fortschritt"
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${clampedPhaseProgress}%` }}
          />
        </div>
      </section>
    )
  }

  return (
    <section
      data-testid="phase-stepper-desktop"
      aria-label="Import-Schritte"
      className="rounded-[14px] border border-border bg-card px-5 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.04)]"
    >
      <ol className="flex items-center gap-2 overflow-x-auto">
        {phases.map((phase, index) => {
          // Terminal-state branches first:
          //   done  → every step shows as completed (no "current" dot)
          //   error → the slot that was running gets the error marker;
          //           slots before it keep "done", slots after stay pending
          let state: StepState
          if (isDone) {
            state = 'done'
          } else if (isError) {
            state =
              index < errorIndex ? 'done' : index === errorIndex ? 'error' : 'pending'
          } else {
            state =
              index < currentIndex
                ? 'done'
                : index === currentIndex
                  ? 'current'
                  : 'pending'
          }
          return (
            <li
              key={phase}
              data-testid={`phase-step-${phase}`}
              data-state={state}
              className="flex min-w-0 flex-1 items-center gap-2"
            >
              <StepDot index={index} state={state} />
              <span
                className={cn(
                  'truncate text-[12.5px] font-medium',
                  state === 'current' && 'text-foreground',
                  state === 'done' && 'text-[hsl(var(--muted-foreground))]',
                  state === 'error' && 'text-[hsl(var(--destructive))]',
                  state === 'pending' && 'text-[hsl(var(--muted-foreground)/0.7)]',
                )}
              >
                {phaseLabel(phase)}
              </span>
              {index < phases.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'mx-1 h-px flex-1 min-w-4',
                    state === 'done'
                      ? 'bg-primary/40'
                      : 'bg-[hsl(var(--muted))]',
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

type StepState = 'done' | 'current' | 'pending' | 'error'

function StepDot({ index, state }: { index: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    )
  }
  if (state === 'current') {
    return (
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full border-2 border-primary text-[11px] font-semibold text-primary">
        {index + 1}
      </span>
    )
  }
  if (state === 'error') {
    return (
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[hsl(var(--destructive))] text-[hsl(var(--destructive-foreground))]">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    )
  }
  return (
    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full border border-[hsl(var(--muted-foreground)/0.35)] text-[11px] font-medium text-[hsl(var(--muted-foreground))]">
      {index + 1}
    </span>
  )
}
