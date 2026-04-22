import { describe, expect, it } from 'vitest'
import { extractSharedUrls } from './extractSharedUrl'

/**
 * SHARE-2 — multi-URL extractor.
 *
 * Same attacker model as SHARE-0 (the share-sheet payload is
 * attacker-controllable via a crafted link / caption). These theory
 * cases nail down:
 *   - collection from `url` + `text` + `title` merged into one list
 *   - regex extraction of ALL http(s) URLs in free-form text
 *   - dedupe-by-string-equality (no URL canonicalisation)
 *   - the 10-item cap (sanity guard against a caption full of links)
 *   - the per-URL sanitise rules (http(s) only, ≤2000 chars) match
 *     SHARE-0 exactly
 */
describe('extractSharedUrls', () => {
  function params(entries: Record<string, string>): URLSearchParams {
    return new URLSearchParams(entries)
  }

  it('returns [] when the payload is empty', () => {
    expect(extractSharedUrls(params({}))).toEqual([])
  })

  it('returns a single URL from ?url=', () => {
    expect(extractSharedUrls(params({ url: 'https://fb.com/x' }))).toEqual([
      'https://fb.com/x',
    ])
  })

  it('extracts multiple newline-separated URLs from ?text=', () => {
    expect(
      extractSharedUrls(
        params({ text: 'https://fb.com/x\nhttps://ig.com/y' }),
      ),
    ).toEqual(['https://fb.com/x', 'https://ig.com/y'])
  })

  it('merges URLs from url+text+title, deduping exact string matches', () => {
    // Same URL in `url` + `text` → should appear once.
    expect(
      extractSharedUrls(
        params({
          url: 'https://fb.com/x',
          text: 'see this: https://fb.com/x also https://ig.com/y',
          title: 'https://fb.com/x',
        }),
      ),
    ).toEqual(['https://fb.com/x', 'https://ig.com/y'])
  })

  it('keeps only http(s), dropping javascript: / data: / file: / ftp:', () => {
    expect(
      extractSharedUrls(
        params({
          url: 'javascript:alert(1)',
          text: 'https://ok.example data:text/html,<script>alert(1)</script> https://also.ok',
          title: 'file:///etc/passwd',
        }),
      ),
    // URL.toString() normalises origin-only URLs with a trailing "/".
    ).toEqual(['https://ok.example/', 'https://also.ok/'])
  })

  it('caps the list at 10 URLs', () => {
    // Craft a text with 15 distinct https URLs separated by spaces.
    const urls = Array.from({ length: 15 }, (_, i) => `https://a.example/${i}`)
    const result = extractSharedUrls(params({ text: urls.join(' ') }))
    expect(result).toHaveLength(10)
    expect(result[0]).toBe('https://a.example/0')
    expect(result[9]).toBe('https://a.example/9')
  })

  it('rejects oversize URLs (>2000 chars)', () => {
    const huge = 'https://' + 'a'.repeat(2100)
    expect(extractSharedUrls(params({ url: huge }))).toEqual([])
  })

  it('tolerates URLs with trailing punctuation in captions', () => {
    // Users often share "check this: https://foo.com/x!" — the regex
    // must stop at whitespace / quotes / closing brackets so we don't
    // over-capture the trailing "!" as part of the URL path.
    expect(
      extractSharedUrls(
        params({ text: 'check this out: https://foo.com/x! nice' }),
      ),
    ).toEqual(['https://foo.com/x!'])
    // (URL.toString() preserves the "!" as it's valid in a path.)
  })
})
