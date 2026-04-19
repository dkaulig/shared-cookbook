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
import {
  safeGetItem,
  safeRemoveItem,
  safeSetItem,
} from '@/features/_shared/safeStorage'

const STORAGE_PREFIX = 'fk.importGroup.'
const STAGED_PHOTOS_PREFIX = 'fk.importStagedPhotos.'

function key(importId: string): string {
  return `${STORAGE_PREFIX}${importId}`
}

function stagedKey(importId: string): string {
  return `${STAGED_PHOTOS_PREFIX}${importId}`
}

export function rememberImportGroup(importId: string, groupId: string): void {
  safeSetItem(key(importId), groupId)
}

export function recallImportGroup(importId: string): string | null {
  return safeGetItem(key(importId))
}

export function forgetImportGroup(importId: string): void {
  safeRemoveItem(key(importId))
  safeRemoveItem(stagedKey(importId))
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
  safeSetItem(stagedKey(importId), JSON.stringify(stagedPhotoIds))
}

export function recallImportStagedPhotoIds(importId: string): string[] | null {
  const raw = safeGetItem(stagedKey(importId))
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return null
  }
}
