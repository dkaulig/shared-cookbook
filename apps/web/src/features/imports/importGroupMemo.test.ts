import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetImportGroup,
  recallImportGroup,
  recallImportStagedPhotoIds,
  rememberImportGroup,
  rememberImportStagedPhotoIds,
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

  describe('rememberImportStagedPhotoIds + recall', () => {
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
})
