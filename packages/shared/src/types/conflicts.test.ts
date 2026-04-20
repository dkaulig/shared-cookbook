import { describe, expect, it } from 'vitest'
import type { VersionMismatchError } from './conflicts.ts'

describe('VersionMismatchError', () => {
  it('accepts the canonical 409 body shape', () => {
    // Typecheck-only: compile-time failure here means the wire shape
    // drifted from what the backend produces.
    const body: VersionMismatchError = {
      code: 'version_mismatch',
      message: 'Der Eintrag wurde zwischenzeitlich geändert.',
      current: {
        id: '11111111-2222-3333-4444-555555555555',
        version: 7,
      },
    }
    expect(body.code).toBe('version_mismatch')
    expect(body.message).toContain('zwischenzeitlich')
  })

  it('narrows `current` via a user-defined predicate', () => {
    interface ExampleDto {
      id: string
      version: number
    }
    function hasIdAndVersion(v: unknown): v is ExampleDto {
      return (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as { id?: unknown }).id === 'string' &&
        typeof (v as { version?: unknown }).version === 'number'
      )
    }

    const body: VersionMismatchError = {
      code: 'version_mismatch',
      message: 'x',
      current: { id: 'abc', version: 2 },
    }

    expect(hasIdAndVersion(body.current)).toBe(true)
    if (hasIdAndVersion(body.current)) {
      expect(body.current.version).toBe(2)
    }
  })
})
