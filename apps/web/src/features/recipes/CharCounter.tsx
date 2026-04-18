import { cn } from '@/lib/utils'

export interface CharCounterProps {
  /** Current value of the paired input/textarea. Only the length is read. */
  value: string
  /** Hard maximum character count (inclusive). */
  max: number
  /** Optional extra classes — parent-driven alignment. */
  className?: string
}

/**
 * DS6 inline character counter rendered beneath inputs and textareas
 * whose native `maxLength` is set. Matches `.char-count` in
 * `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Neutral 11 px muted text while the input has headroom.
 *   - Amber warning once ≥ 80 % of the hard limit is used.
 *   - Destructive-red once the user is at the hard limit.
 *
 * Pure projection: the counter does not enforce the limit — the input's
 * `maxLength` attribute is the source of truth. This component only
 * surfaces progress.
 */
export function CharCounter({ value, max, className }: CharCounterProps) {
  const count = [...value].length
  const ratio = max > 0 ? count / max : 0
  const tone =
    count >= max
      ? 'text-[hsl(var(--destructive))]'
      : ratio >= 0.8
        ? 'text-amber-700'
        : 'text-[hsl(var(--muted-foreground))]'

  return (
    <div
      className={cn('mt-0.5 text-right text-[11px]', tone, className)}
      aria-live="polite"
    >
      {count} / {max}
    </div>
  )
}
