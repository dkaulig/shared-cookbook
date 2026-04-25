import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/**
 * COOK-1 — internal TimerChip state machine.
 *
 * - `idle`    → initial, shows "⏱ label", tap to start.
 * - `running` → decrementing 1 Hz, shows MM:SS, tap to pause.
 * - `paused`  → holds remaining seconds, tap to resume, ✕ to reset.
 * - `done`    → reached 0, shows "Fertig!", ✕ to reset. Fires vibration.
 */
export type TimerChipStatus = 'idle' | 'running' | 'paused' | 'done'

export interface TimerChipState {
  status: TimerChipStatus
  remaining: number
}

export interface TimerChipProps {
  /** Human-readable label shown in idle state (e.g. "10 Minuten"). */
  label: string
  /** Starting seconds when the timer runs for the first time. */
  initialSeconds: number
  /**
   * Current state — the parent (CookModePage) owns a
   * `Map<timerId, TimerChipState>` so stepping away + back preserves
   * the running countdown. `undefined` collapses to a default idle
   * state so the parent can lazily populate entries in its map.
   */
  state: TimerChipState | undefined
  /** Propagate every state transition (tick, pause, reset) to the parent. */
  onStateChange: (next: TimerChipState) => void
}

function formatMMSS(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
}

export function TimerChip({
  label,
  initialSeconds,
  state: controlledState,
  onStateChange,
}: TimerChipProps) {
  const { t } = useTranslation()
  // The state prop may be `undefined` for a not-yet-created entry in
  // the parent's map — we present a default idle state in that case so
  // the parent can populate on first interaction.
  const state: TimerChipState = controlledState ?? {
    status: 'idle',
    remaining: initialSeconds,
  }

  const updateRef = useRef(onStateChange)
  const remainingRef = useRef(state.remaining)
  const statusRef = useRef(state.status)

  // Mirror the latest values into refs so the single stable setInterval
  // closure below reads fresh data without re-creating itself on every
  // tick. Assignment inside useEffect satisfies react-hooks/refs which
  // forbids ref writes during render.
  useEffect(() => {
    updateRef.current = onStateChange
    remainingRef.current = state.remaining
    statusRef.current = state.status
  })

  // Single stable 1 Hz interval that only mutates state while running.
  // We mount/dismount it when `status` moves in/out of 'running' —
  // nothing else retriggers the effect so we never thrash setInterval.
  useEffect(() => {
    if (state.status !== 'running') return
    const id = setInterval(() => {
      if (statusRef.current !== 'running') return
      const next = remainingRef.current - 1
      if (next <= 0) {
        remainingRef.current = 0
        statusRef.current = 'done'
        updateRef.current({ status: 'done', remaining: 0 })
      } else {
        remainingRef.current = next
        updateRef.current({ status: 'running', remaining: next })
      }
    }, 1000)
    return () => clearInterval(id)
  }, [state.status])

  // Fire vibration once when entering done state. Optional chaining
  // handles unsupported platforms — no mainstream browser throws from
  // this call synchronously, so the helper's try/catch was dead weight.
  const prevStatusRef = useRef<TimerChipStatus>(state.status)
  useEffect(() => {
    if (prevStatusRef.current !== 'done' && state.status === 'done') {
      navigator.vibrate?.(200)
    }
    prevStatusRef.current = state.status
  }, [state.status])

  function handleMainTap() {
    if (state.status === 'idle') {
      onStateChange({ status: 'running', remaining: initialSeconds })
    } else if (state.status === 'running') {
      onStateChange({ status: 'paused', remaining: state.remaining })
    } else if (state.status === 'paused') {
      onStateChange({ status: 'running', remaining: state.remaining })
    }
  }

  function handleReset() {
    onStateChange({ status: 'idle', remaining: initialSeconds })
  }

  // Visual variant by status.
  const base =
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[15px] font-semibold transition-[background-color,opacity,color] duration-200'
  let variant = ''
  let body: React.ReactNode
  if (state.status === 'idle') {
    variant = 'bg-[hsl(var(--muted))] text-foreground hover:bg-[hsl(var(--muted)/0.8)]'
    body = (
      <>
        <span aria-hidden="true">⏱</span>
        <span>{label}</span>
      </>
    )
  } else if (state.status === 'running') {
    variant = 'bg-[hsl(38_92%_50%/0.18)] text-[hsl(38_92%_30%)] ring-1 ring-[hsl(38_92%_50%/0.45)]'
    body = (
      <>
        <span aria-hidden="true">⏱</span>
        <span className="[font-variant-numeric:tabular-nums]">{formatMMSS(state.remaining)}</span>
      </>
    )
  } else if (state.status === 'paused') {
    variant =
      'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] ring-1 ring-[hsl(var(--border))]'
    body = (
      <>
        <span aria-hidden="true">⏸</span>
        <span className="[font-variant-numeric:tabular-nums]">{formatMMSS(state.remaining)}</span>
      </>
    )
  } else {
    variant =
      'bg-[hsl(142_71%_35%/0.18)] text-[hsl(142_71%_28%)] ring-1 ring-[hsl(142_71%_35%/0.45)] animate-pulse'
    body = (
      <>
        <span aria-hidden="true">✅</span>
        <span>Fertig!</span>
      </>
    )
  }

  return (
    <span
      data-testid="timer-chip"
      data-status={state.status}
      className="inline-flex items-center gap-1 align-middle"
    >
      <button
        type="button"
        onClick={handleMainTap}
        aria-label={
          state.status === 'idle'
            ? `Timer starten: ${label}`
            : state.status === 'running'
              ? `Timer pausieren (${formatMMSS(state.remaining)})`
              : state.status === 'paused'
                ? `Timer fortsetzen (${formatMMSS(state.remaining)})`
                : `Timer fertig`
        }
        className={cn(base, variant)}
      >
        {body}
      </button>
      {(state.status === 'paused' || state.status === 'done') && (
        <button
          type="button"
          onClick={handleReset}
          aria-label={t('recipes.cook.timerResetAria', {
            defaultValue: 'Timer zurücksetzen',
          })}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))]"
        >
          ✕
        </button>
      )}
    </span>
  )
}
