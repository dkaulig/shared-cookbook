import { cn } from '@/lib/utils'

interface OverallProgressBarProps {
  /** 0–100 weighted global progress. */
  value: number
  /** Optional German copy shown next to the percent readout. */
  label?: string | null
  /** Extra class names pass-through for layout composition. */
  className?: string
}

/**
 * PV3 — single-responsibility progress-bar wrapper for the import
 * progress page. Extracted from the previous inline markup in
 * `ImportProgressPage` so the bar can render next to a phase stepper
 * + detail card without the parent juggling four layers of flex
 * containers. Exposes correct ARIA semantics for screen readers
 * (`role="progressbar"` + `aria-valuenow/-min/-max`) — required by
 * the design-doc §Frontend Components.
 *
 * Values are clamped to [0, 100] and rounded to the nearest integer
 * on render so a payload drift (e.g. `progress: 101` from an overeager
 * server rounding) cannot push the inner bar past the container.
 */
export function OverallProgressBar({
  value,
  label,
  className,
}: OverallProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <section
      className={cn(
        'rounded-[18px] border border-border bg-card px-6 py-6 shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
        className,
      )}
    >
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label="Import-Fortschritt"
        className="h-2 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-3">
        {label ? (
          <p className="text-[15px] font-semibold leading-snug text-foreground">
            {label}
          </p>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="text-[12.5px] font-medium tabular-nums text-[hsl(var(--muted-foreground))]">
          {clamped}%
        </span>
      </div>
    </section>
  )
}
