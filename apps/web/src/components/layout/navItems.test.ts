import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { navItems } from './navItems'

/**
 * TABLET-0 drift guard — BottomNav + SideRail must both consume the
 * shared `navItems` module. Imports are grepped from source to avoid
 * a future refactor re-introducing a hard-coded local list in either
 * file (which would re-create the drift risk this slice set out to
 * eliminate).
 */

const HERE = dirname(fileURLToPath(import.meta.url))

function readSource(rel: string): string {
  return readFileSync(resolve(HERE, rel), 'utf8')
}

describe('navItems — shared source of truth', () => {
  it('exposes the five primary routes in the documented order (SEARCH-1 adds Suche between Gruppen and Wochenplan)', () => {
    expect(navItems.map((item) => item.to)).toEqual([
      '/',
      '/groups',
      '/suche',
      '/wochenplan',
      '/profil',
    ])
  })

  it('ships German labels for every item', () => {
    const labels = navItems.map((item) => item.label)
    expect(labels).toEqual(['Start', 'Gruppen', 'Suche', 'Wochenplan', 'Profil'])
  })

  it('includes a Suche entry with the Lucide Search icon (SEARCH-1)', () => {
    const suche = navItems.find((item) => item.to === '/suche')
    expect(suche).toBeDefined()
    expect(suche?.label).toBe('Suche')
    // Lucide icons expose a `displayName` under test conditions; fall
    // back to `name` for the forwardRef form.
    const iconName =
      (suche?.icon as { displayName?: string; name?: string }).displayName ??
      (suche?.icon as { displayName?: string; name?: string }).name ??
      ''
    expect(iconName).toMatch(/Search/i)
  })

  it('every item carries a Lucide icon component', () => {
    for (const item of navItems) {
      // Lucide icons are `forwardRef` components — the type is `object`
      // in runtime terms, not `function`. Guard that it's present and
      // truthy rather than asserting a specific shape.
      expect(item.icon).toBeTruthy()
    }
  })

  it('BottomNav.tsx imports navItems (no hand-rolled copy)', () => {
    const source = readSource('./BottomNav.tsx')
    expect(source).toMatch(/from ['"]\.\/navItems['"]/)
    // And must NOT redeclare its own const items array — that would
    // reintroduce the drift risk the shared module was built to kill.
    expect(source).not.toMatch(/const\s+items\s*:\s*NavItem\[\]\s*=/)
  })

  it('SideRail.tsx imports navItems (no hand-rolled copy)', () => {
    const source = readSource('./SideRail.tsx')
    expect(source).toMatch(/from ['"]\.\/navItems['"]/)
  })
})
