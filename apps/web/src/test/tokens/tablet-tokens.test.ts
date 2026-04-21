import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * TABLET-0 — verifies the tablet-zone CSS variables live in the same
 * `:root` block as the existing layout tokens (--bottom-nav-height,
 * --topnav-height). Keeping them together guards against someone
 * adding them in a stray @media block or a component-local `:root`
 * override, which would silently break the cascade.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const CSS_PATH = resolve(HERE, '../../index.css')

describe('TABLET-0 CSS variables', () => {
  const css = readFileSync(CSS_PATH, 'utf8')

  it('defines --side-rail-width: 72px in :root', () => {
    expect(css).toMatch(/--side-rail-width:\s*72px/)
  })

  it('defines --split-left-width: 340px in :root', () => {
    expect(css).toMatch(/--split-left-width:\s*340px/)
  })

  it('co-locates the tablet tokens in the same :root block as --topnav-height and --bottom-nav-height', () => {
    // Grab the first :root { ... } block and assert all four tokens live
    // inside it. Using a lazy regex so we stop at the first closing brace.
    const rootBlockMatch = css.match(/:root\s*\{([\s\S]*?)\}/)
    expect(rootBlockMatch).not.toBeNull()
    const body = rootBlockMatch?.[1] ?? ''
    expect(body).toMatch(/--bottom-nav-height/)
    expect(body).toMatch(/--topnav-height/)
    expect(body).toMatch(/--side-rail-width/)
    expect(body).toMatch(/--split-left-width/)
  })
})
