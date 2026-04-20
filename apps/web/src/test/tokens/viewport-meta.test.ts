import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BUG-037 regression gate — the `interactive-widget=resizes-content`
 * token on `<meta name="viewport">` is the Chrome 108+ / Firefox 132+
 * opt-in that shrinks the LAYOUT viewport in lockstep with the VISUAL
 * viewport when the on-screen keyboard or URL bar animates. Without it
 * `position: fixed; bottom: 0` leaves a gap above the retracting
 * browser chrome on Chrome Mobile (Safari/WebKit ignores the token but
 * is harmless).
 *
 * This test reads `apps/web/index.html` verbatim and asserts the token
 * is present on the viewport meta tag so the fix can't silently
 * regress via an accidental edit to the meta string.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = resolve(HERE, '../../../index.html')

describe('BUG-037 — viewport meta must enable interactive-widget=resizes-content', () => {
  it('`<meta name="viewport">` contains `interactive-widget=resizes-content`', () => {
    const html = readFileSync(INDEX_HTML, 'utf8')
    const match = html.match(/<meta\s+name=["']viewport["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    expect(match, 'viewport meta tag missing from index.html').not.toBeNull()
    const content = match![1]
    expect(content).toMatch(/interactive-widget=resizes-content/)
  })

  it('keeps `viewport-fit=cover` (still required for iOS safe-area-inset)', () => {
    const html = readFileSync(INDEX_HTML, 'utf8')
    const match = html.match(/<meta\s+name=["']viewport["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    expect(match).not.toBeNull()
    expect(match![1]).toMatch(/viewport-fit=cover/)
  })
})
