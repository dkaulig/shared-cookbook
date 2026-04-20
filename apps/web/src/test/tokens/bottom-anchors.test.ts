import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BUG-032 regression gate — on mobile, the project anchors page-scoped
 * sticky sub-navs to the shared `--topnav-height` CSS var and fixed
 * bottom-edge overlays (FABs, action bars) to `--bottom-nav-height` +
 * `--viewport-bottom-offset`. Hard-coded pixel values for `top` on
 * sticky elements or for `bottom` in `fixed`'s inline style drift out
 * of sync the moment TopNav/BottomNav change height, OR the moment
 * iOS/Chrome retracts its toolbar and BottomNav follows the visual
 * viewport while the literal pixel element stays put.
 *
 * This file walks every `.tsx` under `apps/web/src` and flags two
 * narrowly-scoped patterns that reintroduced BUG-032 before the fix:
 *
 *   1) A className string that contains BOTH `sticky` (or `fixed`)
 *      AND `top-[<NN>px]` where NN is a literal integer. The allowed
 *      form is `top-[var(--topnav-height)]` (or `top-0`), so any
 *      `top-[…px]` hit on a sticky/fixed element trips the gate.
 *   2) An inline-style `bottom: 'calc(<NN>px …)'` where the calc
 *      starts with a hard-coded pixel literal instead of one of the
 *      runtime tokens `var(--bottom-nav-height)` /
 *      `var(--viewport-bottom-offset)`. Matching only `calc(<digits>px`
 *      prefixes keeps the rule tight and avoids false positives on
 *      legitimate inline `bottom: <N>px` usage in non-chrome UI.
 *
 * Allowed by design:
 *   - `top-0` / `bottom-0` (0 is the explicit "flush" anchor).
 *   - `inset-0` on modal/backdrops (full-viewport cover, not a
 *     bottom-chrome anchor).
 *   - `top-[<NN>px]` on `fixed` elements when the element's own
 *     Tailwind layering is below the TopNav but NOT a sticky-sub-nav
 *     (e.g. ChatSessionsShell's floating "Unterhaltungen" pill at
 *     `top-[72px]`) — we intentionally scope the sticky-top rule to
 *     `sticky` only, not to `fixed`.
 *
 * On regression the test prints the file + offending snippet so the
 * reviewer doesn't have to re-run with a debugger to find the hit.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(HERE, '../../')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (stat.isFile() && full.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

// A classname string literal (double- or single-quoted) that contains
// `sticky` somewhere plus a `top-[<digits>px]` somewhere else in the
// same string. We scan string-literals instead of raw JSX attributes
// because many components concatenate classes through `cn(...)` calls
// across multiple lines; per-string scanning keeps false positives out.
const STICKY_WITH_LITERAL_TOP_RE =
  /["'`][^"'`]*\bsticky\b[^"'`]*\btop-\[\d+px\][^"'`]*["'`]|["'`][^"'`]*\btop-\[\d+px\][^"'`]*\bsticky\b[^"'`]*["'`]/g

// Inline-style `bottom: 'calc(<NN>px …)'` where the leading term is a
// bare pixel literal instead of a CSS var. We don't ban `calc()` itself
// — only the specific flavour that hard-codes the offset from the
// visual bottom edge.
const INLINE_BOTTOM_LITERAL_CALC_RE = /bottom:\s*['"`]calc\(\s*\d+px\b/g

describe('BUG-032 — sticky/fixed bottom & top anchors must reference CSS vars', () => {
  const files = walk(SRC_ROOT)

  it('no sticky element anchors `top` to a literal `top-[<NN>px]`', () => {
    const offenders: string[] = []
    for (const file of files) {
      // Skip the gate itself and any test that deliberately asserts
      // the OLD literal is GONE (those carry `top-[56px]` as a
      // negative assertion).
      if (file.endsWith('bottom-anchors.test.ts')) continue
      if (file.endsWith('.test.tsx') || file.endsWith('.test.ts')) continue

      const source = readFileSync(file, 'utf8')
      const matches = source.match(STICKY_WITH_LITERAL_TOP_RE)
      if (!matches) continue
      const rel = file.slice(SRC_ROOT.length + 1)
      for (const m of matches) {
        offenders.push(`${rel}: ${m.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no inline `bottom: calc(<NN>px …)` — must use var(--bottom-nav-height) etc.', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith('bottom-anchors.test.ts')) continue
      if (file.endsWith('.test.tsx') || file.endsWith('.test.ts')) continue

      const source = readFileSync(file, 'utf8')
      const matches = source.match(INLINE_BOTTOM_LITERAL_CALC_RE)
      if (!matches) continue
      const rel = file.slice(SRC_ROOT.length + 1)
      for (const m of matches) {
        offenders.push(`${rel}: ${m.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
