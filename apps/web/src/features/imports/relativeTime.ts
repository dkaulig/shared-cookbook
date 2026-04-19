/**
 * BUG-010 — German "vor N Minuten" / "vor N Stunden" formatter used by
 * {@link ./ImportListPage.tsx}. Extracted into its own module so the
 * import-list file only exports React components (react-refresh rule).
 *
 * Uses the platform `Intl.RelativeTimeFormat` with locale `de` and the
 * `numeric: 'auto'` mode — that's what turns `-1` minute into the
 * idiomatic "vor einer Minute" instead of the literal "vor 1 Minute".
 *
 * Why not date-fns? Constraint from the bug task: no new packages.
 * `Intl.RelativeTimeFormat` is universally available on every browser
 * the PWA targets and produces the exact strings we need with zero
 * bundle overhead.
 *
 * Returns the empty string on unparseable input so a stray bad
 * timestamp from the server can't blow up the list render.
 */
export function formatRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const deltaMs = ts - now.getTime()
  const deltaSec = Math.round(deltaMs / 1000)
  const abs = Math.abs(deltaSec)
  const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto' })

  if (abs < 60) return rtf.format(Math.round(deltaSec), 'second')
  if (abs < 3600) return rtf.format(Math.round(deltaSec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(deltaSec / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(deltaSec / 86400), 'day')
  if (abs < 86400 * 365)
    return rtf.format(Math.round(deltaSec / (86400 * 30)), 'month')
  return rtf.format(Math.round(deltaSec / (86400 * 365)), 'year')
}
