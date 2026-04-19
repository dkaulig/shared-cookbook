import { dayKeys } from './weekGrid'

/**
 * Pure helper: given a week's Monday (`weekStart`, ISO `YYYY-MM-DD`) +
 * the user's current day (`todayIso`, same format), return the set of
 * days that should be expanded on first render of `MobileDayStack`.
 *
 *  - If `todayIso` is inside [weekStart..weekStart+6]: open today and
 *    (when in-range) the next day. Sunday of the current week → only
 *    Sunday; no wrap into next week's Monday.
 *  - Else (historical or future week): open Monday — the pragmatic
 *    "first-day" fallback, keeps the existing 1-day-open behaviour
 *    from before P3-10 default-open was made today-aware.
 *
 * Kept pure (no `new Date()` internally) so tests can pass a fixed
 * `todayIso` without stubbing the global clock. Lives in a sibling
 * helper module (not `MobileDayStack.tsx`) so react-refresh HMR keeps
 * working on the component file — the `react-refresh/only-export-
 * components` rule rejects mixed-export files.
 */
export function defaultOpenDays(
  weekStart: string,
  todayIso: string,
): ReadonlySet<string> {
  const days = dayKeys(weekStart)
  const open = new Set<string>()
  const todayIdx = days.indexOf(todayIso)
  if (todayIdx >= 0) {
    const today = days[todayIdx]
    if (today) open.add(today)
    const next = days[todayIdx + 1]
    if (next) open.add(next)
    return open
  }
  const monday = days[0]
  if (monday) open.add(monday)
  return open
}
