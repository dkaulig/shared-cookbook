/**
 * Session-scoped memo: map an `importId` to the `groupId` it was
 * enqueued against, so the progress page + the RecipeFormPage prefill
 * know where to route the user once extraction completes.
 *
 * PF1 — the photo-import flow now ALSO stashes the
 * `stagedPhotoIds` here, so the create-recipe payload assembled in
 * `RecipeFormPage` can attach the originals once the user saves.
 * Stored as a JSON-encoded string under a sibling key so the legacy
 * groupId-only consumer keeps working unchanged.
 *
 * Why this exists: the P2-6 `GET /api/imports/{id}` response does not
 * include the groupId (its shape was fixed before the P2-7 UI dispatch
 * and changing it is out of scope for P2-7 — the plan explicitly bans
 * backend changes). So we keep a client-side sidecar.
 *
 * Why sessionStorage (not localStorage):
 * - Automatically cleared when the tab closes — no stale entries.
 * - Survives soft refreshes within the same tab, which is the main
 *   reload case we care about on the progress screen.
 * - Users on multiple devices don't leak state to each other.
 *
 * Contract:
 * - Writes happen on enqueue success (the ImportUrlPage stashes the
 *   groupId it just POSTed with; the ImportPhotosPage additionally
 *   stashes the stagedPhotoIds it just uploaded).
 * - Reads happen on the progress page + the recipe-form prefill;
 *   consumers fall back gracefully when the memo is missing (e.g. the
 *   user shared the progress URL to another tab).
 */
const STORAGE_PREFIX = 'fk.importGroup.'
const STAGED_PHOTOS_PREFIX = 'fk.importStagedPhotos.'

function key(importId: string): string {
  return `${STORAGE_PREFIX}${importId}`
}

function stagedKey(importId: string): string {
  return `${STAGED_PHOTOS_PREFIX}${importId}`
}

function storageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    // Private-mode Safari + very restrictive settings can throw on
    // access. Not worth warning — fall back to "no memo".
    return null
  }
}

export function rememberImportGroup(importId: string, groupId: string): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.setItem(key(importId), groupId)
  } catch {
    /* quota exceeded or storage disabled — silent no-op. */
  }
}

export function recallImportGroup(importId: string): string | null {
  const s = storageOrNull()
  if (!s) return null
  try {
    return s.getItem(key(importId))
  } catch {
    return null
  }
}

export function forgetImportGroup(importId: string): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.removeItem(key(importId))
    s.removeItem(stagedKey(importId))
  } catch {
    /* ignore */
  }
}

/**
 * PF1 — stash the staged-photo ids that the photo import just
 * uploaded. The create-recipe handler reads them so the originals
 * land on the saved recipe automatically. JSON-encoded so an empty
 * list still round-trips as `[]`, distinguishing "user uploaded zero"
 * from "no memo present" (which the recall function returns as
 * `null`).
 */
export function rememberImportStagedPhotoIds(
  importId: string,
  stagedPhotoIds: string[],
): void {
  const s = storageOrNull()
  if (!s) return
  try {
    s.setItem(stagedKey(importId), JSON.stringify(stagedPhotoIds))
  } catch {
    /* ignore */
  }
}

export function recallImportStagedPhotoIds(importId: string): string[] | null {
  const s = storageOrNull()
  if (!s) return null
  try {
    const raw = s.getItem(stagedKey(importId))
    if (raw == null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return null
  }
}
