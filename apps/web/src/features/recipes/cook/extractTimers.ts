/**
 * COOK-1 — inline timer extraction for cook-step text (German).
 *
 * Scans the step content for German time expressions and returns one
 * match per cookable duration. Overlap handling: the regex is run in a
 * single pass with alternation so ranges like "2-3 Stunden" are matched
 * as ONE token — the inner "3 Stunden" / "2 Stunden" are not separately
 * extracted because they're already covered by the range match. For
 * ranges we take the UPPER bound (kochen soll eher länger als zu kurz).
 *
 * False-positive filtering: we intentionally keep the filter simple —
 * any numeric + unit match passes through. The user can still choose
 * not to start the timer if "24 h" doesn't make sense for their step.
 */
export interface ExtractedTimer {
  matchStart: number
  matchEnd: number
  label: string
  seconds: number
}

// Unit alternation, longest-first so "minuten" is tried before "min".
// We use the /i flag rather than enumerating every case variant.
const UNIT_HOUR_SRC = 'stunden|stunde|std|h'
const UNIT_MIN_SRC = 'minuten|minute|min\\.?'
const UNIT_SEC_SRC = 'sekunden|sekunde|sek|s(?!\\w)'

const UNIT_SRC = `(?:${UNIT_HOUR_SRC}|${UNIT_MIN_SRC}|${UNIT_SEC_SRC})`

// Range form: `N1 [-–—] N2 unit` (longest match wins per engine-run).
// Plain form: `N unit`.
const TIMER_PATTERN = new RegExp(
  `(?:(\\d+)\\s*[-–—]\\s*(\\d+)\\s*(${UNIT_SRC}))|(?:(\\d+)\\s*(${UNIT_SRC}))`,
  'gi',
)

function unitToSeconds(unit: string, n: number): number {
  const u = unit.toLowerCase().replace(/\.$/, '')
  if (u === 'h' || u === 'std' || u.startsWith('stund')) return n * 3600
  if (u === 'min' || u.startsWith('minut')) return n * 60
  // 's', 'sek', 'sekunde(n)'
  return n
}

export function extractTimers(stepText: string): ExtractedTimer[] {
  if (!stepText) return []
  const results: ExtractedTimer[] = []
  TIMER_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null = null
  while ((match = TIMER_PATTERN.exec(stepText)) !== null) {
    const [full, , rHi, rUnit, pN, pUnit] = match
    const matchStart = match.index
    const matchEnd = match.index + full.length
    let seconds: number
    let label: string
    if (rHi !== undefined && rUnit !== undefined) {
      const n = Number.parseInt(rHi, 10)
      seconds = unitToSeconds(rUnit, n)
      label = full.trim()
    } else if (pN !== undefined && pUnit !== undefined) {
      const n = Number.parseInt(pN, 10)
      seconds = unitToSeconds(pUnit, n)
      label = full.trim()
    } else {
      continue
    }
    results.push({ matchStart, matchEnd, label, seconds })
  }
  return results.sort((a, b) => a.matchStart - b.matchStart)
}
