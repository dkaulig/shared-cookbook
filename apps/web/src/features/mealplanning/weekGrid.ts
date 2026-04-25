import type { MealPlanSlotDto, MealSlot } from '@shared-cookbook/shared'

/**
 * Pure helpers for the Wochenplan grid. They operate on ISO `YYYY-MM-DD`
 * strings so the wire format (see `packages/shared/src/types/mealPlanning.ts`)
 * flows through the UI without ever needing a `Date` round-trip at the
 * caller side.
 *
 * Dates are interpreted in UTC deliberately. Using `new Date(iso)`
 * would parse `YYYY-MM-DD` as UTC-midnight, which can slip into the
 * previous day when `getDate()` / `getDay()` read in a local timezone
 * east of UTC. We therefore do the arithmetic in UTC and format back
 * to ISO manually.
 */

export const MEAL_SLOTS = ['Frühstück', 'Mittag', 'Abend', 'Snack'] as const

export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  Frühstück: 'Frühstück',
  Mittag: 'Mittag',
  Abend: 'Abend',
  Snack: 'Snack',
}

export const WEEKDAY_LABELS = [
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
] as const

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIso(iso: string): Date {
  const match = ISO_RE.exec(iso)
  if (!match) throw new Error(`Invalid ISO date: ${iso}`)
  const [, y, m, d] = match
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
}

function toIso(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0')
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = date.getUTCDate().toString().padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * `Date#getUTCDay()` returns 0 (Sunday)..6 (Saturday). We return
 * a Monday-anchored index 0..6 where 0 = Montag so the grid mapping is
 * obvious.
 */
function mondayIndex(date: Date): number {
  return (date.getUTCDay() + 6) % 7
}

export function isMonday(iso: string): boolean {
  return mondayIndex(parseIso(iso)) === 0
}

export function toMondayIso(iso: string): string {
  const d = parseIso(iso)
  d.setUTCDate(d.getUTCDate() - mondayIndex(d))
  return toIso(d)
}

export function addDaysIso(iso: string, offset: number): string {
  const d = parseIso(iso)
  d.setUTCDate(d.getUTCDate() + offset)
  return toIso(d)
}

export function nextMonday(weekStartIso: string): string {
  return addDaysIso(toMondayIso(weekStartIso), 7)
}

export function prevMonday(weekStartIso: string): string {
  return addDaysIso(toMondayIso(weekStartIso), -7)
}

export function dayKeys(weekStartIso: string): readonly string[] {
  const monday = toMondayIso(weekStartIso)
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i))
}

export function formatGermanDate(iso: string): string {
  const match = ISO_RE.exec(iso)
  if (!match) throw new Error(`Invalid ISO date: ${iso}`)
  const [, y, m, d] = match
  return `${d}.${m}.${y}`
}

export function formatWeekRange(weekStartIso: string): string {
  const monday = toMondayIso(weekStartIso)
  const sunday = addDaysIso(monday, 6)
  return `${formatGermanDate(monday)} – ${formatGermanDate(sunday)}`
}

/**
 * ISO-8601 week number (week 1 is the week containing Jan 4th). Matches
 * the number German users see in calendars (`KW 17`).
 */
export function isoWeekNumber(iso: string): number {
  const d = parseIso(iso)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const diffDays = (d.getTime() - yearStart.getTime()) / 86_400_000
  return Math.ceil((diffDays + 1) / 7)
}

export type WeekSlotBuckets = Record<string, Record<MealSlot, MealPlanSlotDto[]>>

/**
 * Buckets the API's flat slot list into a nested `[date][meal]` structure
 * sorted by `sortOrder`. Every (date, meal) cell is guaranteed to be an
 * array — missing keys would force the JSX layer into defensive `?? []`
 * guards at every cell render.
 *
 * Slots falling outside `[weekStart, weekStart+6]` are silently dropped
 * — the backend already enforces this range, but we guard the grid so a
 * faulty cache entry can't leak stale slots into other weeks.
 */
export function slotsByDayMeal(
  slots: readonly MealPlanSlotDto[],
  weekStartIso: string,
): WeekSlotBuckets {
  const buckets: WeekSlotBuckets = {}
  const keys = dayKeys(weekStartIso)
  for (const date of keys) {
    buckets[date] = {
      Frühstück: [],
      Mittag: [],
      Abend: [],
      Snack: [],
    }
  }

  for (const slot of slots) {
    const bucket = buckets[slot.date]
    if (!bucket) continue
    bucket[slot.meal].push(slot)
  }

  for (const date of keys) {
    const dayBucket = buckets[date]
    if (!dayBucket) continue
    for (const meal of MEAL_SLOTS) {
      dayBucket[meal].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
      )
    }
  }

  return buckets
}
