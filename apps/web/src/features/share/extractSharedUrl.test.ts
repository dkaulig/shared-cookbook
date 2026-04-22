import { describe, expect, it } from 'vitest'
import { extractSharedUrl } from './extractSharedUrl'

/**
 * SHARE-0 — iOS PWA Web Share Target helper.
 *
 * The share sheet payload is attacker-controllable (anyone who can
 * craft a link or a Share-Sheet entry can drop arbitrary data into
 * `?url=`, `?text=`, `?title=`). These theory cases nail down the
 * priority order (`url > text > title`), the regex fallback for the
 * common Facebook "share-to-text" case, and the security gates
 * (http(s) only, 2000 char cap) that stop hostile payloads reaching
 * the import pipeline.
 */
describe('extractSharedUrl', () => {
  function params(entries: Record<string, string>): URLSearchParams {
    return new URLSearchParams(entries)
  }

  it('returns ?url= when present', () => {
    expect(extractSharedUrl(params({ url: 'https://fb.com/x' }))).toBe(
      'https://fb.com/x',
    )
  })

  it('falls back to ?text= when ?url= missing', () => {
    expect(extractSharedUrl(params({ text: 'https://fb.com/x' }))).toBe(
      'https://fb.com/x',
    )
  })

  it('falls back to ?title= when ?url= and ?text= both missing', () => {
    expect(extractSharedUrl(params({ title: 'https://fb.com/x' }))).toBe(
      'https://fb.com/x',
    )
  })

  it('extracts a URL embedded in a multi-line text payload (FB case)', () => {
    expect(
      extractSharedUrl(
        params({ text: 'Check this out!\nhttps://fb.com/x rest of caption' }),
      ),
    ).toBe('https://fb.com/x')
  })

  it('prefers ?url= over ?text= when both are present', () => {
    expect(
      extractSharedUrl(params({ url: 'https://a.example', text: 'https://b.example' })),
    ).toBe('https://a.example/')
  })

  it('returns null when the text contains no URL', () => {
    expect(extractSharedUrl(params({ text: 'no url here' }))).toBeNull()
  })

  it('returns null for an empty payload', () => {
    expect(extractSharedUrl(params({}))).toBeNull()
  })

  it('rejects the javascript: scheme', () => {
    expect(
      extractSharedUrl(params({ url: 'javascript:alert(1)' })),
    ).toBeNull()
  })

  it('rejects the file: scheme', () => {
    expect(extractSharedUrl(params({ url: 'file:///etc/passwd' }))).toBeNull()
  })

  it('rejects oversize URLs (>2000 chars)', () => {
    const huge = 'https://' + 'a'.repeat(2100)
    expect(extractSharedUrl(params({ url: huge }))).toBeNull()
  })
})
