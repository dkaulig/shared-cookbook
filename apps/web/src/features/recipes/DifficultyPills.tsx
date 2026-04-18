import { cn } from '@/lib/utils'

export type DifficultyLevel = 1 | 2 | 3

export interface DifficultyPillsProps {
  /** Currently selected difficulty (1 = Einfach, 2 = Mittel, 3 = Aufwendig). */
  value: DifficultyLevel
  /** Fired when a non-selected pill is tapped. No-op if the same pill is tapped twice. */
  onChange: (next: DifficultyLevel) => void
  /** Optional className for the outer group element. */
  className?: string
}

interface PillConfig {
  level: DifficultyLevel
  label: string
}

const PILLS: readonly PillConfig[] = [
  { level: 1, label: 'Einfach' },
  { level: 2, label: 'Mittel' },
  { level: 3, label: 'Aufwendig' },
] as const

/**
 * DS6 single-select difficulty pill group.
 *
 * Mirrors `.difficulty-group` / `.diff-btn` in
 * `docs/mockups/warme-kueche-recipe-form.html`:
 *
 *   - Three pills across a full row, each flex-1 so they stretch to fill.
 *   - Selected pill: amber background + cream text + amber border.
 *   - Unselected pill: cream background + muted-stone border + muted text;
 *     hover previews the amber border + text.
 *   - Dot glyphs scale with difficulty (1/2/3 filled circles).
 *
 * Controlled component — no internal state. The parent holds the current
 * `value`; selecting the already-active pill is a no-op (we don't call
 * `onChange` to avoid spurious draft-mutations in the RecipeFormPage).
 */
export function DifficultyPills({ value, onChange, className }: DifficultyPillsProps) {
  return (
    <div role="group" aria-label="Schwierigkeit" className={cn('flex gap-1.5', className)}>
      {PILLS.map(({ level, label }) => {
        const selected = value === level
        return (
          <button
            key={level}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onChange(level)
            }}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-3 py-[9px] text-[14px] font-medium transition-colors',
              selected
                ? 'border-primary bg-primary text-[hsl(var(--primary-foreground))]'
                : 'border-[hsl(var(--input))] bg-background text-[hsl(var(--muted-foreground))] hover:border-primary hover:text-primary',
            )}
          >
            <span className="inline-flex gap-[2px]" aria-hidden="true">
              {Array.from({ length: level }).map((_, i) => (
                <span
                  key={i}
                  data-dot
                  className="h-1.5 w-1.5 rounded-full bg-current"
                />
              ))}
            </span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
