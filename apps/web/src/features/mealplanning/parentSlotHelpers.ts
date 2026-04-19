import type { MealPlanSlotDto, MealSlot } from '@familien-kochbuch/shared'
import { MEAL_SLOTS } from './weekGrid'

/**
 * Pure helpers for the P3-4 "Meal-Prep / Parent-Slot" UX.
 *
 * `ParentSlotId` links a leftover slot back to the slot that actually
 * cooks the food (see plan section P3-0 data-model). The frontend
 * needs four derived views of that relation:
 *   - {@link childrenOf}        — direct children of a given slot,
 *     used by `MealPlanPage` to warn the user before deleting a parent.
 *   - {@link findDescendantIds} — transitive closure of children, used
 *     by the edit dialog to exclude illegal cycle-creating parent picks.
 *   - {@link eligibleParents}   — candidate parent list for the "Ist
 *     Rest von …" dropdown, sorted chronologically.
 *   - {@link buildParentLabel}  — short German reference label rendered
 *     on the slot card badge ("Mo Mittag") and inside the dropdown
 *     ("Mo Mittag: Gulasch (4 Portionen)").
 *
 * All helpers are pure + defensive: they never mutate their inputs and
 * silently drop references to slots that no longer exist (which can
 * happen because the backend nulls `ParentSlotId` when a parent is
 * deleted — see plan section P3-1).
 */

const WEEKDAY_SHORT = [
  'Mo',
  'Di',
  'Mi',
  'Do',
  'Fr',
  'Sa',
  'So',
] as const

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * German short-weekday for an ISO `YYYY-MM-DD` date. Uses UTC parsing
 * to match `weekGrid`'s timezone discipline — parsing a bare YYYY-MM-DD
 * via the default Date constructor can slip a day east of UTC.
 */
function weekdayShort(iso: string): string {
  const match = ISO_RE.exec(iso)
  if (!match) return ''
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  // `getUTCDay()` returns 0=Sun..6=Sat; shift so 0=Mon matches the
  // WEEKDAY_SHORT array layout.
  const idx = (date.getUTCDay() + 6) % 7
  return WEEKDAY_SHORT[idx] ?? ''
}

/**
 * Stable meal-order index: Frühstück → Mittag → Abend → Snack. Used
 * as a secondary sort key so the parent dropdown reads chronologically
 * within a day even when slots share the same date.
 */
function mealOrder(meal: MealSlot): number {
  const idx = MEAL_SLOTS.indexOf(meal)
  return idx < 0 ? MEAL_SLOTS.length : idx
}

/**
 * Canonical display title for a slot — mirrors the convention used by
 * `SortableSlotCard` so the badge + dropdown labels stay in sync with
 * what the user sees on the card itself.
 *
 * Preference order:
 *   1. Trimmed `label` if present (user-typed free-text or recipe
 *      override note)
 *   2. "Rezept" fallback when a recipe is linked but no label set
 *   3. "Unbenanntes Gericht" when nothing is available
 */
function slotTitle(slot: MealPlanSlotDto): string {
  const trimmed = slot.label?.trim()
  if (trimmed && trimmed.length > 0) return trimmed
  if (slot.recipeId) return 'Rezept'
  return 'Unbenanntes Gericht'
}

/**
 * Direct children of `slotId` — slots whose `parentSlotId` points at
 * it. One level only; use {@link findDescendantIds} for the transitive
 * closure.
 */
export function childrenOf(
  slotId: string,
  allSlots: readonly MealPlanSlotDto[],
): readonly MealPlanSlotDto[] {
  return allSlots.filter((s) => s.parentSlotId === slotId)
}

/**
 * Set of all descendant slot-ids for `rootId` (children, grandchildren,
 * …). Used by {@link eligibleParents} to prevent a user from creating
 * a cycle by picking one of the editing slot's descendants as its own
 * parent.
 *
 * Traversal is iterative + guarded by a visited set so malformed data
 * (a cycle that somehow slipped past the backend's domain check) can't
 * hang the UI.
 */
export function findDescendantIds(
  rootId: string,
  allSlots: readonly MealPlanSlotDto[],
): ReadonlySet<string> {
  const descendants = new Set<string>()
  const stack: string[] = [rootId]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const slot of allSlots) {
      if (slot.parentSlotId !== current) continue
      if (descendants.has(slot.id)) continue
      descendants.add(slot.id)
      stack.push(slot.id)
    }
  }
  return descendants
}

/**
 * Build the human-readable parent reference used on the slot card
 * badge and in the dropdown options.
 *
 * Formats:
 *   - `short = true`  → "Mo Mittag"                          (badge copy)
 *   - `short = false` → "Mo Mittag: Gulasch (4 Portionen)"  (dropdown)
 */
export function buildParentLabel(
  parent: MealPlanSlotDto,
  options: { short?: boolean } = {},
): string {
  const short = options.short ?? false
  const prefix = `${weekdayShort(parent.date)} ${parent.meal}`.trim()
  if (short) return prefix
  const title = slotTitle(parent)
  const servings = parent.servings
  const servingsWord = servings === 1 ? 'Portion' : 'Portionen'
  return `${prefix}: ${title} (${servings} ${servingsWord})`
}

/**
 * Candidate parents for the "Ist Rest von …" dropdown when the user
 * is creating (`editingSlotId = null`) or editing a slot.
 *
 * Exclusion rules:
 *   - the editing slot itself (would self-reference)
 *   - every descendant of the editing slot (would create a cycle —
 *     e.g. editing A where A→B and picking B as A's parent inverts the
 *     chain to an illegal B→A→B loop).
 *
 * Sort: date ASC, then meal order (Frühstück…Snack), then `sortOrder`
 * within the same cell — matches the visual flow of the week grid so
 * the user can find their target by scrolling top-to-bottom.
 */
export function eligibleParents(
  editingSlotId: string | null,
  allSlots: readonly MealPlanSlotDto[],
): readonly MealPlanSlotDto[] {
  const excluded = new Set<string>()
  if (editingSlotId !== null) {
    excluded.add(editingSlotId)
    for (const id of findDescendantIds(editingSlotId, allSlots)) {
      excluded.add(id)
    }
  }
  const candidates = allSlots.filter((s) => !excluded.has(s.id))
  return [...candidates].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    const mealDiff = mealOrder(a.meal) - mealOrder(b.meal)
    if (mealDiff !== 0) return mealDiff
    return a.sortOrder - b.sortOrder
  })
}
