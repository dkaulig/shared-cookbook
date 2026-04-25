import { useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import type { IngredientDto, ScaledIngredient } from '@shared-cookbook/shared'
import { scaleIngredients } from '@shared-cookbook/shared'
import { cn } from '@/lib/utils'

/**
 * COMP-2 — one component's slice of the mise-en-place list. The cook
 * page materialises these from the `RecipeDetailDto.components` array
 * and hands them to {@link MiseEnPlaceList}, which renders one sticky
 * sub-header per entry (suppressed on single-default recipes).
 */
export interface MiseEnPlaceGroup {
  /** Stable key for the group — reused as React key + component id hint. */
  key: string
  /** German-ready label. Null labels get resolved to "Hauptgericht" upstream. */
  label: string
  /** Ingredients scoped to this component, ordered by position. */
  ingredients: IngredientDto[]
}

export interface MiseEnPlaceListProps {
  /**
   * COMP-2 — ingredient groups, one per component. Single-default
   * recipes pass a single group; the sticky sub-header is suppressed
   * in that case so the UX matches the pre-COMP-2 flat list.
   */
  groups: Array<{
    component: { id?: string; position: number; label: string | null }
    label: string
    ingredients: IngredientDto[]
  }>
  /** Recipe's own default-servings count — "from" side of the scaling ratio. */
  defaultServings: number
  /** Session portions chosen in the picker — "to" side of the scaling ratio. */
  sessionServings: number
  /** Checked-state — owned by the parent so it survives re-opening the portions picker. */
  checked: Set<string>
  /** Parent-owned toggle — receives the row key. */
  onToggle: (key: string) => void
  /**
   * COOK-2 — when set, the matching ingredient row is scrolled into
   * view + briefly ring-highlighted (1.5 s). The list owns the full
   * fade-out lifecycle locally — the parent just sets the prop and
   * never clears it. A repeat-tap on the same ingredient re-triggers
   * the flash via `highlightNonce` (see below).
   */
  highlightedIngredientId?: string | null
  /**
   * COOK-2 — monotonically increasing counter that the parent bumps on
   * every ingredient-chip tap, even when `highlightedIngredientId`
   * doesn't change. Drives the fade-out effect so re-tapping the same
   * ingredient restarts the ring without the id flipping through null.
   */
  highlightNonce?: number
}

/**
 * COOK-0 + COOK-2 Mise-en-Place checklist (Step 0).
 *
 * Bigger-than-IngredientChecklist version of the same tap-to-check
 * grid: ~72 px row, 52 px checkbox, 20-22 px body copy. Same scaling
 * math via the shared `scaleIngredients` helper so rounding and unit
 * formatting match the detail page exactly.
 *
 * COOK-2 adds an optional `highlightedIngredientId` prop. When an
 * ingredient chip in a cook-step is tapped, `CookModePage` navigates
 * back to step 0 and sets this prop — we then scroll the row into
 * view + apply a ring highlight that fades out after 1.5 s.
 *
 * Checked-state lives on the parent (`CookModePage`) so it persists
 * across step-navigation and even across a re-open of the portions
 * picker. Scaled quantities re-render automatically when the session
 * portions change — the check state is keyed on a stable row key that
 * doesn't depend on the scaled value.
 */
export function MiseEnPlaceList({
  groups,
  defaultServings,
  sessionServings,
  checked,
  onToggle,
  highlightedIngredientId = null,
  highlightNonce = 0,
}: MiseEnPlaceListProps) {
  // COMP-2 — scale all groups in one pass so the rendering code below
  // can zip group.ingredients × scaledFlat in index-order. The scaler
  // doesn't care about component boundaries; it just maps each input
  // row to a scaled output row in the same order.
  const scaled = useMemo<ScaledIngredient[]>(() => {
    if (sessionServings <= 0 || defaultServings <= 0) return []
    const flat = groups.flatMap((g) => g.ingredients)
    return scaleIngredients(
      flat.map((i) => ({
        quantity: i.quantity ?? null,
        unit: i.unit,
        name: i.name,
        scalable: i.scalable,
      })),
      defaultServings,
      sessionServings,
    )
  }, [groups, defaultServings, sessionServings])

  // Flash-ring state. The ring is ON whenever `highlightedIngredientId`
  // is set AND the fade-out timer for the CURRENT `highlightNonce`
  // hasn't fired yet. Tracking the nonce (not the id) as the "already
  // faded" marker lets a repeat-tap on the same id restart the flash —
  // each activation comes with a fresh nonce from the parent, so the
  // "faded" check fails for the new tap and the ring lights up again.
  // The effect is only responsible for SCHEDULING the fade; it never
  // flips the ring ON from within, which keeps `react-hooks/
  // set-state-in-effect` happy.
  const [fadedNonce, setFadedNonce] = useState<number | null>(null)
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())

  useEffect(() => {
    if (highlightedIngredientId == null) return
    const target = rowRefs.current.get(highlightedIngredientId)
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const clearHandle = setTimeout(() => {
      setFadedNonce(highlightNonce)
    }, 1500)
    return () => clearTimeout(clearHandle)
  }, [highlightedIngredientId, highlightNonce])

  // The ring is ON when the prop names a non-null id AND the fade-out
  // timer for THIS activation (nonce) hasn't fired yet.
  const activeFlashId =
    highlightedIngredientId != null && fadedNonce !== highlightNonce
      ? highlightedIngredientId
      : null

  function rowKey(ingredient: IngredientDto, index: number): string {
    return ingredient.id ?? `pos-${ingredient.position}-${index}`
  }

  // Suppress sub-headers on the single-default case so the UX is
  // byte-identical to pre-COMP-2.
  const showSubHeaders =
    groups.length > 1 ||
    (groups[0] && groups[0].component.label !== null)

  // Pre-compute the cumulative offset into `scaled` for each group so
  // the inner render map doesn't need a mutable counter (the react-
  // hooks/immutability lint rule forbids in-render reassignment).
  const groupOffsets: number[] = []
  {
    let running = 0
    for (const g of groups) {
      groupOffsets.push(running)
      running += g.ingredients.length
    }
  }

  return (
    <div
      data-testid="cook-mise-en-place"
      className="mx-auto w-full max-w-2xl px-6 pb-6 md:px-12"
    >
      <h2 className="mb-2 font-serif text-[30px] font-semibold tracking-[-0.01em] text-foreground md:text-[36px]">
        Mise en Place
      </h2>
      <p className="mb-6 text-[16px] leading-relaxed text-[hsl(var(--muted-foreground))] md:text-[18px]">
        Bereite diese Zutaten vor. Tippe zum Abhaken, wenn alles bereit
        ist.
      </p>

      {groups.map((group, gIdx) => {
        const groupKey =
          group.component.id ??
          `comp-${group.component.position}-${gIdx}`
        return (
          <div
            key={groupKey}
            data-testid="cook-mise-en-place-group"
            className={gIdx > 0 ? 'mt-4' : ''}
          >
            {showSubHeaders && (
              <h3
                data-testid="cook-mise-en-place-subheader"
                className="sticky top-0 z-10 -mx-6 mb-2 bg-background/95 px-6 pb-2 pt-1 text-[14px] font-semibold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))] backdrop-blur-sm md:-mx-12 md:px-12"
              >
                {group.label}
              </h3>
            )}
            <ul className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
              {group.ingredients.map((ingredient, index) => {
                const key = rowKey(ingredient, index)
                const display = scaled[groupOffsets[gIdx]! + index]
                const isChecked = checked.has(key)
                const isHighlighted =
                  activeFlashId != null && activeFlashId === ingredient.id
                return (
                  <li key={key}>
                    <IngredientRow
                      ingredient={ingredient}
                      display={display}
                      isChecked={isChecked}
                      isHighlighted={isHighlighted}
                      onToggle={() => onToggle(key)}
                      isLast={index === group.ingredients.length - 1}
                      registerRef={(el) => {
                        if (ingredient.id) rowRefs.current.set(ingredient.id, el)
                      }}
                    />
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function IngredientRow({
  ingredient,
  display,
  isChecked,
  isHighlighted,
  onToggle,
  isLast,
  registerRef,
}: {
  ingredient: IngredientDto
  display: ScaledIngredient | undefined
  isChecked: boolean
  isHighlighted: boolean
  onToggle: () => void
  isLast: boolean
  registerRef: (el: HTMLButtonElement | null) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isChecked}
      onClick={onToggle}
      ref={registerRef}
      className={cn(
        'flex w-full items-center gap-4 px-5 py-5 text-left transition-[background-color,box-shadow] duration-300 hover:bg-[hsl(var(--muted))]',
        // min-h so a 44×44 tap target is guaranteed even if the row
        // content would otherwise be shorter; reserved space prevents
        // the line-through variant from causing a layout shift.
        'min-h-[72px]',
        !isLast && 'border-b border-[hsl(var(--border)/0.55)]',
        isHighlighted && 'ring-2 ring-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.08)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid h-[32px] w-[32px] flex-shrink-0 place-items-center rounded-md border-2 transition-all',
          isChecked
            ? 'border-[hsl(142_71%_29%)] bg-[hsl(142_71%_29%)] text-white'
            : 'border-[hsl(var(--input))] text-transparent',
        )}
      >
        <Check className="h-5 w-5" strokeWidth={3} />
      </span>
      <span
        className={cn(
          'min-w-[100px] flex-shrink-0 font-semibold text-foreground',
          '[font-variant-numeric:tabular-nums] text-[19px]',
          isChecked && 'text-[hsl(var(--muted-foreground))]',
        )}
      >
        {display?.displayQuantity ?? ''}
      </span>
      <span
        className={cn(
          'flex-1 text-[19px] leading-snug text-foreground',
          isChecked && 'line-through text-[hsl(var(--muted-foreground))]',
        )}
      >
        {ingredient.name}
        {ingredient.note && (
          <span className="mt-0.5 block text-[14px] text-[hsl(var(--muted-foreground))]">
            {ingredient.note}
          </span>
        )}
      </span>
    </button>
  )
}
