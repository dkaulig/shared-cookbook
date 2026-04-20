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
 *
 * BUG-024 — the staged-photo memo now persists the signed URL
 * alongside the id so the review form can render the actual
 * thumbnails (via `PhotoUploadGrid.preAttached`) instead of only
 * showing a count-badge. Storage key stays the same and the reader
 * still accepts the legacy `string[]` shape (URL falls back to "")
 * so sessions written by an older build keep working.
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
 * A staged photo as persisted in the import memo. `url` is the
 * signed SeaweedFS URL returned by `uploadStagedPhoto` (aka
 * `StagedPhotoResponse.signedUrl`). Kept as a plain object (not a
 * tuple) so the JSON shape is self-describing.
 */
export interface ImportStagedPhotoMemo {
  readonly stagedPhotoId: string
  readonly url: string
}

/**
 * BUG-024 — persist `{id, url}` pairs. Accepts a readonly array so
 * callers can pass the upload-result collector directly.
 *
 * Stores an empty array as `[]` (distinct from "missing" which the
 * recall function returns as `null`) so consumers can tell apart
 * "user uploaded zero photos" from "no memo present".
 */
export function rememberImportStagedPhotos(
  importId: string,
  stagedPhotos: readonly ImportStagedPhotoMemo[],
): void {
  const serialisable = stagedPhotos.map((p) => ({
    stagedPhotoId: p.stagedPhotoId,
    url: p.url,
  }))
  safeSetItem(stagedKey(importId), JSON.stringify(serialisable))
}

/**
 * BUG-024 — legacy shim kept on the id-only surface so code that
 * doesn't have URLs (tests, corner cases) stays ergonomic. The
 * underlying JSON shape is always the new `{id,url}` form; URLs are
 * stored as empty strings here.
 */
export function rememberImportStagedPhotoIds(
  importId: string,
  stagedPhotoIds: readonly string[],
): void {
  rememberImportStagedPhotos(
    importId,
    stagedPhotoIds.map((id) => ({ stagedPhotoId: id, url: '' })),
  )
}

/**
 * BUG-024 — returns the full `{id, url}` array (or null when no memo
 * was written). Degrades gracefully for sessions written by older
 * builds: a plain `string[]` persists is read back as
 * `[{ id, url: '' }]` so the form still knows the ids, just won't
 * render thumbnails (same behaviour as pre-BUG-024).
 */
export function recallImportStagedPhotos(
  importId: string,
): ImportStagedPhotoMemo[] | null {
  const raw = safeGetItem(stagedKey(importId))
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const out: ImportStagedPhotoMemo[] = []
    for (const entry of parsed) {
      if (typeof entry === 'string') {
        // Legacy shape: plain id strings. Fall through with empty
        // URL so the form degrades to the pre-BUG-024 "badge only"
        // experience for this session.
        out.push({ stagedPhotoId: entry, url: '' })
        continue
      }
      if (
        entry &&
        typeof entry === 'object' &&
        'stagedPhotoId' in entry &&
        typeof (entry as { stagedPhotoId: unknown }).stagedPhotoId ===
          'string'
      ) {
        const id = (entry as { stagedPhotoId: string }).stagedPhotoId
        const urlRaw = (entry as { url?: unknown }).url
        const url = typeof urlRaw === 'string' ? urlRaw : ''
        out.push({ stagedPhotoId: id, url })
      }
    }
    return out
  } catch {
    return null
  }
}

/**
 * BUG-024 — id-only recall (backward-compatible with the original
 * API). Projects the full memo down to the bare string array so
 * call-sites that only need ids (the save POST body) don't have to
 * map through an object.
 */
export function recallImportStagedPhotoIds(importId: string): string[] | null {
  const full = recallImportStagedPhotos(importId)
  if (full == null) return null
  return full.map((p) => p.stagedPhotoId)
}

/**
 * BUG-024 — drop the staged-photo memo for an importId without
 * touching the groupId memo (the caller has already navigated away
 * from the review form). Used by the remove-preAttached handler
 * when the user deletes one of the already-staged photos.
 */
export function forgetImportStagedPhotos(importId: string): void {
  safeRemoveItem(stagedKey(importId))
}
