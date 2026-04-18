/**
 * Wall-clock → German greeting helper used by the Home page hero's
 * kicker line ("Guten Abend, David" etc.).
 *
 * The buckets match how the mockup speaks: morning 05-11, day 12-17,
 * evening 18-22, night 23-04. We keep them in one helper so the
 * copy is consistent across the app (same string on Home hero, Profile
 * page, future welcome toasts, etc.).
 */
export type LocaleTimeGreeting = 'Guten Morgen' | 'Guten Tag' | 'Guten Abend' | 'Gute Nacht'

export function localeTimeGreeting(now: Date = new Date()): LocaleTimeGreeting {
  const hour = now.getHours()
  if (hour >= 5 && hour <= 11) return 'Guten Morgen'
  if (hour >= 12 && hour <= 17) return 'Guten Tag'
  if (hour >= 18 && hour <= 22) return 'Guten Abend'
  return 'Gute Nacht'
}
