import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Label } from './label'

describe('<Label />', () => {
  it('renders a <label> with the Warme-Küche 13 px semibold style', () => {
    render(<Label htmlFor="email">E-Mail-Adresse</Label>)
    const label = screen.getByText('E-Mail-Adresse')
    expect(label.tagName).toBe('LABEL')
    // Mockup uses font-size 13 + weight 600 for form labels.
    expect(label.className).toMatch(/text-\[13px\]/)
    expect(label.className).toMatch(/font-semibold/)
  })

  it('forwards the htmlFor association', () => {
    render(<Label htmlFor="pw">Passwort</Label>)
    const label = screen.getByText('Passwort')
    expect(label.getAttribute('for')).toBe('pw')
  })

  it('merges caller-supplied className', () => {
    render(<Label className="extra-label">L</Label>)
    expect(screen.getByText('L').className).toMatch(/extra-label/)
  })

  it('keeps the peer-disabled opacity fallback', () => {
    // Regression: form primitives in later slices rely on
    // `peer-disabled:opacity-70` being kept even after the restyle.
    render(<Label>L</Label>)
    expect(screen.getByText('L').className).toMatch(/peer-disabled:opacity-70/)
  })
})
