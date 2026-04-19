import type { ImportStatus } from '@familien-kochbuch/shared'

/**
 * Progress labels per P2-7 plan step 4.
 *
 * - `queued` — before a worker picks up the job.
 * - `running && progress <= 30` — "Video wird geladen …".
 * - `running && progress <= 60` — "Transkribieren …".
 * - `running && progress <= 90` — "Rezept strukturieren …".
 * - `running && progress <= 100` — "Abschluss …".
 *
 * Fuzz around 30/60/90 is fine — the bounds are inclusive upper
 * cutoffs (`<=`), not exact equality. The plan's anti-shortcut note
 * calls this out explicitly.
 */
export function progressLabel(status: ImportStatus, progress: number): string {
  if (status === 'queued') return 'Warteschlange …'
  if (status === 'done') return 'Fertig.'
  if (status === 'error') return 'Fehler.'
  if (progress <= 30) return 'Video wird geladen …'
  if (progress <= 60) return 'Transkribieren …'
  if (progress <= 90) return 'Rezept strukturieren …'
  return 'Abschluss …'
}
