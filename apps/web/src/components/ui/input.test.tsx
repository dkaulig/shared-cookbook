import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from './input'

describe('<Input />', () => {
  it('renders an <input> element with Warme-Küche padding + border tokens', () => {
    render(<Input placeholder="du@familie.de" />)
    const input = screen.getByPlaceholderText('du@familie.de')
    expect(input.tagName).toBe('INPUT')
    // DS1 bumps the height to ~44px (h-11) and switches to the Warme-Küche
    // border-input token so the cream background / stone-300 border combo
    // from the mockup comes through without a per-call override.
    expect(input.className).toMatch(/h-11/)
    expect(input.className).toMatch(/border-input/)
    expect(input.className).toMatch(/text-base/)
  })

  it('carries the 4-ring amber focus style from the mockup', () => {
    render(<Input placeholder="p" />)
    const input = screen.getByPlaceholderText('p')
    // Mockup uses `box-shadow: 0 0 0 4px rgba(180,83,9,0.25)` on :focus.
    // We translate that into Tailwind's focus-visible:ring-4 +
    // focus-visible:ring-ring/25 (amber-700 @ 25% alpha).
    expect(input.className).toMatch(/focus-visible:ring-4/)
    expect(input.className).toMatch(/focus-visible:ring-ring/)
  })

  it('merges caller-supplied className without dropping defaults', () => {
    render(<Input className="custom-input" placeholder="x" />)
    const input = screen.getByPlaceholderText('x')
    expect(input.className).toMatch(/custom-input/)
    expect(input.className).toMatch(/h-11/)
  })

  it('forwards native input attributes (type, disabled, required)', () => {
    render(
      <Input type="email" disabled required placeholder="disabled" />,
    )
    const input = screen.getByPlaceholderText('disabled') as HTMLInputElement
    expect(input.type).toBe('email')
    expect(input.disabled).toBe(true)
    expect(input.required).toBe(true)
  })
})
