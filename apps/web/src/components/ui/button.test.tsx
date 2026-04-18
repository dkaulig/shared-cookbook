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
    expect(classes).toMatch(/h-10/)
  })
})
