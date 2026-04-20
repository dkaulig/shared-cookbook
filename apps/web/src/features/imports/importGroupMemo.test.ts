import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetImportGroup,
  forgetImportStagedPhotos,
  recallImportGroup,
  recallImportStagedPhotoIds,
  recallImportStagedPhotos,
  rememberImportGroup,
  rememberImportStagedPhotoIds,
  rememberImportStagedPhotos,
} from './importGroupMemo'

describe('importGroupMemo', () => {
  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('round-trips groupId via remember/recall', () => {
    rememberImportGroup('imp-1', 'group-a')
    expect(recallImportGroup('imp-1')).toBe('group-a')
  })

  it('returns null for an unknown importId', () => {
    expect(recallImportGroup('missing')).toBeNull()
  })

  it('forgets both groupId AND stagedPhotoIds in a single call', () => {
    rememberImportGroup('imp-2', 'group-b')
    rememberImportStagedPhotoIds('imp-2', ['s1', 's2'])

    forgetImportGroup('imp-2')

    expect(recallImportGroup('imp-2')).toBeNull()
    expect(recallImportStagedPhotoIds('imp-2')).toBeNull()
  })

  describe('rememberImportStagedPhotoIds + recall (id-only shim)', () => {
    it('round-trips an array of ids in order', () => {
      rememberImportStagedPhotoIds('imp-x', ['a', 'b', 'c'])
      expect(recallImportStagedPhotoIds('imp-x')).toEqual(['a', 'b', 'c'])
    })

    it('round-trips an empty array as []', () => {
      // Distinguishing "user uploaded zero" (empty array, but the
      // memo IS present) from "no memo" (null) matters because the
      // form needs to know whether to skip the photo-import branch.
      rememberImportStagedPhotoIds('imp-empty', [])
      expect(recallImportStagedPhotoIds('imp-empty')).toEqual([])
    })

    it('returns null when no memo was written', () => {
      expect(recallImportStagedPhotoIds('imp-never')).toBeNull()
    })

    it('filters out non-string entries from the persisted JSON defensively', () => {
      window.sessionStorage.setItem(
        'fk.importStagedPhotos.bad',
        JSON.stringify(['ok-id', 7, null, 'also-ok']),
      )
      expect(recallImportStagedPhotoIds('bad')).toEqual(['ok-id', 'also-ok'])
    })

    it('returns null when the persisted JSON is malformed', () => {
      window.sessionStorage.setItem(
        'fk.importStagedPhotos.broken',
        '{not valid json',
      )
      expect(recallImportStagedPhotoIds('broken')).toBeNull()
    })

    it('returns null when the persisted JSON is not an array', () => {
      window.sessionStorage.setItem(
        'fk.importStagedPhotos.obj',
        JSON.stringify({ id: 'wrong-shape' }),
      )
      expect(recallImportStagedPhotoIds('obj')).toBeNull()
    })
  })

  // BUG-024 — the memo now persists {stagedPhotoId, url} objects so
  // RecipeFormPage can render the actual thumbnails via
  // PhotoUploadGrid.preAttached instead of only showing a count-pill.
  describe('rememberImportStagedPhotos + recallImportStagedPhotos (new shape)', () => {
    it('round-trips {id, url} pairs in order', () => {
      rememberImportStagedPhotos('imp-n1', [
        { stagedPhotoId: 's1', url: '/api/photos/s1.jpg?sig=a' },
        { stagedPhotoId: 's2', url: '/api/photos/s2.jpg?sig=b' },
      ])
      expect(recallImportStagedPhotos('imp-n1')).toEqual([
        { stagedPhotoId: 's1', url: '/api/photos/s1.jpg?sig=a' },
        { stagedPhotoId: 's2', url: '/api/photos/s2.jpg?sig=b' },
      ])
    })

    it('recallImportStagedPhotoIds returns just the ids from the new shape', () => {
      rememberImportStagedPhotos('imp-n2', [
        { stagedPhotoId: 'x1', url: '/api/photos/x1.jpg?sig=a' },
        { stagedPhotoId: 'x2', url: '/api/photos/x2.jpg?sig=b' },
      ])
      expect(recallImportStagedPhotoIds('imp-n2')).toEqual(['x1', 'x2'])
    })

    it('empty array round-trips as [] (same "zero uploaded" vs "no memo" contract)', () => {
      rememberImportStagedPhotos('imp-n-empty', [])
      expect(recallImportStagedPhotos('imp-n-empty')).toEqual([])
    })

    it('returns null when no memo was written', () => {
      expect(recallImportStagedPhotos('imp-never')).toBeNull()
    })

    it('forgetImportStagedPhotos drops only the staged-photo key', () => {
      rememberImportGroup('imp-f', 'group-z')
      rememberImportStagedPhotos('imp-f', [
        { stagedPhotoId: 's1', url: '/api/photos/s1.jpg?sig=a' },
      ])

      forgetImportStagedPhotos('imp-f')

      expect(recallImportStagedPhotos('imp-f')).toBeNull()
      // groupId survives — the caller may still need to route after
      // the photo-level cleanup.
      expect(recallImportGroup('imp-f')).toBe('group-z')
    })

    it('reads back a legacy string[] persist as {id, url:""} entries (backward-compat)', () => {
      // Simulate a sessionStorage key written by an older build —
      // plain id strings, no URLs. The reader should not return
      // null; it should degrade to a URL-less list so the form still
      // forwards the ids into the save payload.
      window.sessionStorage.setItem(
        'fk.importStagedPhotos.legacy',
        JSON.stringify(['old-1', 'old-2']),
      )
      expect(recallImportStagedPhotos('legacy')).toEqual([
        { stagedPhotoId: 'old-1', url: '' },
        { stagedPhotoId: 'old-2', url: '' },
      ])
      // And the id-only shim keeps working against the legacy shape.
      expect(recallImportStagedPhotoIds('legacy')).toEqual(['old-1', 'old-2'])
    })

    it('filters out malformed object entries defensively', () => {
      window.sessionStorage.setItem(
        'fk.importStagedPhotos.mixed',
        JSON.stringify([
          { stagedPhotoId: 'ok-1', url: '/u1' },
          { stagedPhotoId: 42, url: '/bad' },
          { url: '/missing-id' },
          { stagedPhotoId: 'ok-2' }, // missing url → defaulted to ''
          'bare-string-ok',
        ]),
      )
      expect(recallImportStagedPhotos('mixed')).toEqual([
        { stagedPhotoId: 'ok-1', url: '/u1' },
        { stagedPhotoId: 'ok-2', url: '' },
        { stagedPhotoId: 'bare-string-ok', url: '' },
      ])
    })
  })
})
