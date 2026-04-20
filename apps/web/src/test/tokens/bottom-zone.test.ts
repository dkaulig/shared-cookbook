import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BUG-036 + BUG-039 regression gate.
 *
 * Under BUG-036 the unified Bottom-Zone made BottomNav the single source
 * of truth for bottom-edge chrome — but BottomNav still used
 * `fixed bottom-[calc(…)]` itself, so the gate carried a small allowlist.
 *
 * BUG-039 went one step further: with the hoppr-style flex-column
 * layout, BottomNav is a flex sibling of `<main>` inside a
 * `fixed inset-0 flex flex-col overflow-hidden` root. Nothing in the app
 * should need `fixed bottom-[calc(…)]` anymore except genuine transient
 * overlays (e.g. PwaUpdatePrompt, RecipeActionBar's inline success/error
 * toast) that sit above BOTH the nav and the scroll content.
 *
 * The gate still scans for the two historical anti-patterns:
 *   - className string `fixed .*bottom-\[calc(…)\]`
 *   - inline style `bottom: 'calc(…)'`
 * And the allowlist is narrow and intentional — see below.
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

// Matches `fixed …bottom-[calc(` inside a single-line quoted string
// (className). Allows arbitrary non-quote, non-newline characters
// between the `fixed` token and the `bottom-[calc(` prefix so multi-
// class className strings still trip.
//
// We intentionally restrict to `'` and `"` quotes (not backticks) so
// JSDoc prose inside /* ... * …`fixed bottom-[calc(`… */ blocks is
// NOT treated as a source-level className and misclassified as an
// offender. We ALSO exclude newlines inside the `[^"'\n]*` bracket
// so a backtick in a JSDoc line followed by a real quoted string
// several lines later can't be stitched into one spurious match.
const FIXED_BOTTOM_CALC_CLASSNAME_RE =
  /["'][^"'\n]*\bfixed\b[^"'\n]*\bbottom-\[calc\(/g

// Matches inline-style `bottom: 'calc(' / "calc("` as JSX attribute.
// Same backtick exclusion rationale as above — backticks inside
// JSDoc should not be matched.
const INLINE_BOTTOM_CALC_RE = /bottom:\s*['"]calc\(/g

// Files allowed to carry these patterns by design:
//   - `pwa/PwaUpdatePrompt.tsx` — system-infra update banner, lives
//     outside the routed app shell entirely (mounted in `main.tsx`),
//     so it MUST position itself against the document viewport.
//   - `features/recipes/RecipeActionBar.tsx` — the 1-2s success/error
//     toast above the 2-button action row; genuine transient overlay
//     that needs to float above every surface including the BottomNav.
//     The `bottom-[calc(env(safe-area-inset-bottom,0px)+88px)]` math
//     doesn't chain any of the removed `--bottom-nav-height` /
//     `--viewport-bottom-offset` tokens — it's a single literal +
//     safe-area inset, which is deliberately outside the gate's scope.
const ALLOWLIST = new Set<string>([
  'pwa/PwaUpdatePrompt.tsx',
  'features/recipes/RecipeActionBar.tsx',
])

function toRel(full: string): string {
  return full.slice(SRC_ROOT.length + 1)
}

describe('BUG-036 + BUG-039 — unified Bottom-Zone gate', () => {
  const files = walk(SRC_ROOT)

  it('no .tsx outside the allowlist mixes `fixed` with `bottom-[calc(`', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = toRel(file)
      // Skip tests — they sometimes assert the OLD pattern is GONE
      // via negative className regex, which would look like a match.
      if (rel.endsWith('.test.tsx') || rel.endsWith('.test.ts')) continue
      if (ALLOWLIST.has(rel)) continue

      const source = readFileSync(file, 'utf8')
      const matches = source.match(FIXED_BOTTOM_CALC_CLASSNAME_RE)
      if (!matches) continue
      for (const m of matches) {
        offenders.push(`${rel}: ${m.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('no .tsx outside the allowlist uses inline `bottom: "calc("` style', () => {
    const offenders: string[] = []
    for (const file of files) {
      const rel = toRel(file)
      if (rel.endsWith('.test.tsx') || rel.endsWith('.test.ts')) continue
      if (ALLOWLIST.has(rel)) continue

      const source = readFileSync(file, 'utf8')
      const matches = source.match(INLINE_BOTTOM_CALC_RE)
      if (!matches) continue
      for (const m of matches) {
        offenders.push(`${rel}: ${m.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('BottomNav.tsx is NO LONGER in the allowlist (BUG-039 — nav is flex-shrink-0, not fixed)', () => {
    // Regression guard: if a future refactor puts BottomNav back on
    // `fixed bottom-[calc(…)]`, someone would have to re-add it to the
    // allowlist. The test below makes that regression loud.
    expect(ALLOWLIST.has('components/layout/BottomNav.tsx')).toBe(false)
  })
})
