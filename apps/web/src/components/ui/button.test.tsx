import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button } from './button'
import { buttonVariants } from './button-variants'

describe('<Button />', () => {
  it('renders its children inside a <button> by default', () => {
    render(<Button>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    expect(button.tagName).toBe('BUTTON')
  })

  it('applies the default variant classes', () => {
    render(<Button>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    // The CVA default variant must include the primary background token.
    expect(button.className).toMatch(/bg-primary/)
  })

  it('uses the Sage Modern sage-dark hover on the default variant', () => {
    // DS8 Sage Modern: hover swaps primary (#4f7961) → primary-hover
    // (#3e6450). DS1 routes that through the --primary-hover CSS var so
    // dark-mode can override it cleanly.
    render(<Button>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    expect(button.className).toMatch(/hover:bg-\[hsl\(var\(--primary-hover\)\)\]/)
  })

  it('carries the sage shadow + tap-scale motion on the default variant', () => {
    // Matches the primary button in variant-a-home.html — soft sage
    // glow beneath + 99% scale on :active.
    render(<Button>Speichern</Button>)
    const button = screen.getByRole('button', { name: 'Speichern' })
    expect(button.className).toMatch(/shadow-/)
    expect(button.className).toMatch(/active:scale-\[0\.99\]/)
  })

  it('supports the destructive variant', () => {
    render(<Button variant="destructive">Löschen</Button>)
    const button = screen.getByRole('button', { name: 'Löschen' })
    expect(button.className).toMatch(/bg-destructive/)
  })

  it('supports the sm size', () => {
    render(<Button size="sm">Klein</Button>)
    const button = screen.getByRole('button', { name: 'Klein' })
    // Small size should produce an h-8 height utility per shadcn defaults.
    expect(button.className).toMatch(/h-8/)
  })

  it('merges a caller-supplied className with the variant classes', () => {
    render(<Button className="custom-extra">Extra</Button>)
    const button = screen.getByRole('button', { name: 'Extra' })
    expect(button.className).toMatch(/custom-extra/)
    expect(button.className).toMatch(/bg-primary/)
  })

  it('forwards native button attributes (type, disabled)', () => {
    render(
      <Button type="submit" disabled>
        Absenden
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Absenden' })
    expect(button).toHaveAttribute('type', 'submit')
    expect(button).toBeDisabled()
  })

  it('exposes a buttonVariants helper that returns class strings', () => {
    const classes = buttonVariants({ variant: 'outline', size: 'lg' })
    expect(typeof classes).toBe('string')
    expect(classes).toMatch(/border/)
    // DS1 bumps lg from h-10 → h-11 to match the mockup's 44px touch
    // target. The default size stays h-10.
    expect(classes).toMatch(/h-11/)
  })
})
