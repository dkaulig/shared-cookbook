import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BUG-036 regression gate — once the Bottom-Zone slot pattern landed,
 * the only components allowed to hand-position themselves at the
 * bottom of the viewport are:
 *
 *   - `src/components/layout/BottomNav.tsx` — the sole `fixed`
 *     container that owns the shared bottom chrome.
 *   - `src/pwa/PwaUpdatePrompt.tsx` — infra-layer update banner
 *     (scope-guard per BUG-036 design: explicitly OUT of the slot
 *     pattern because it's a system-update surface, not page content).
 *
 * Any OTHER file that matches:
 *   - className string `fixed .*bottom-\[calc(…)\]` (arbitrary-value
 *     Tailwind bottom-anchor on a `fixed` element), OR
 *   - inline style `bottom: calc(…)` (JSX `style={{ bottom: 'calc(' }}`),
 * has likely re-introduced a parallel bottom-edge overlay. The test
 * prints the file + snippet so the reviewer can see exactly what
 * slipped through.
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

// Files that are allowed to carry these patterns by design.
const ALLOWLIST = new Set<string>([
  'components/layout/BottomNav.tsx',
  'pwa/PwaUpdatePrompt.tsx',
])

function toRel(full: string): string {
  return full.slice(SRC_ROOT.length + 1)
}

describe('BUG-036 — unified Bottom-Zone gate', () => {
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
})
