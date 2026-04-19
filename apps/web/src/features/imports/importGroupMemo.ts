/**
 * Session-scoped memo: map an `importId` to the `groupId` it was
 * enqueued against (plus, for the photo flow, the `stagedPhotoIds`
 * the upload step produced). Consumed by the progress page + the
 * RecipeFormPage prefill so the user can be routed + the staged
 * photos adopted onto the saved recipe.
 *
 * Why this exists: `GET /api/imports/{id}` doesn't echo the groupId,
 * so the client has to remember it. Kept in sessionStorage so the
 * memo auto-clears on tab close and doesn't leak between devices;
 * consumers fall back gracefully when the memo is absent (e.g. the
 * user shared the progress URL into a new tab).
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
 * JSON-encoded so an empty list round-trips as `[]`, distinguishing
 * "user uploaded zero" from "no memo present" (the latter returns
 * `null` from the recall function).
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
