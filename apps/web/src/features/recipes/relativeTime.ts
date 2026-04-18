/**
 * Compact German "vor X" relative-time formatter for the recipe history
 * panel. Pure function — easy to test deterministically. We deliberately
 * keep this hand-rolled rather than pulling in `date-fns` to avoid the
 * extra ~70 KB it adds for one helper.
 */
export function formatRelativeDe(input: Date | string, now: Date = new Date()): string {
  const target = typeof input === 'string' ? new Date(input) : input
  const diffMs = now.getTime() - target.getTime()

  if (diffMs < 0) return 'in der Zukunft'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'gerade eben'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes === 1 ? 'vor 1 Minute' : `vor ${minutes} Minuten`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? 'vor 1 Stunde' : `vor ${hours} Stunden`

  const days = Math.floor(hours / 24)
  if (days < 30) return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`

  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? 'vor 1 Monat' : `vor ${months} Monaten`

  const years = Math.floor(days / 365)
  return years === 1 ? 'vor 1 Jahr' : `vor ${years} Jahren`
}
