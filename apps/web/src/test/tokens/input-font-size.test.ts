import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * BUG-025 regression gate — iOS Safari (and mobile Chrome) auto-zoom when
 * the user focuses an `<input>`, `<textarea>`, or `<select>` with
 * `font-size < 16px`. This test walks the `apps/web/src` tree, opens each
 * `.tsx` file, and scans for form-input tags whose className tokens
 * include a `text-[(10–15)px]` value anywhere in the element. Any match
 * fails the suite so regressions surface in the PR diff.
 *
 * Coverage includes:
 *   - `<input …>` / `<textarea …>` / `<select …>` tags (direct).
 *   - `<div …>` elements carrying `contentEditable` — iOS zooms those too.
 *
 * Non-input elements (labels, buttons, chips, badges, helper text) are
 * intentionally NOT scanned; their sub-16px sizing is a design choice.
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

// Match an input-ish opening tag (<input / <textarea / <select / a
// <div> carrying contentEditable) together with everything up to the
// closing `>` or self-close `/>`. Multiline-friendly: the className
// prop often spans multiple lines inside `cn(...)` calls.
const INPUT_TAG_RE =
  /<(?:input|textarea|select)\b[^>]*?>|<div\b[^>]*?contentEditable[^>]*?>/gis

// Sub-16px Tailwind arbitrary-font-size token, e.g. `text-[14px]`.
const SUB_16_TEXT_RE = /text-\[(1[0-5])px\]/

describe('BUG-025 — no form-input element renders with font-size < 16px', () => {
  const files = walk(SRC_ROOT)

  it('scans the whole apps/web/src tree for sub-16px input/textarea/select', () => {
    const offenders: string[] = []
    for (const file of files) {
      // Skip self.
      if (file.endsWith('input-font-size.test.ts')) continue
      const source = readFileSync(file, 'utf8')
      const matches = source.match(INPUT_TAG_RE)
      if (!matches) continue
      for (const tag of matches) {
        const hit = tag.match(SUB_16_TEXT_RE)
        if (hit) {
          const rel = file.slice(SRC_ROOT.length + 1)
          offenders.push(`${rel}: ${hit[0]} inside <${tag.slice(1, 20)}…>`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
