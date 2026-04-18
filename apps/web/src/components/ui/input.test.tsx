import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from './input'

describe('<Input />', () => {
  it('renders an <input> element with Sage Modern padding + border tokens', () => {
    render(<Input placeholder="du@familie.de" />)
    const input = screen.getByPlaceholderText('du@familie.de')
    expect(input.tagName).toBe('INPUT')
    // DS1 bumps the height to ~44px (h-11) and uses the Sage Modern
    // border-input token so the neutral background / stone-border combo
    // from the mockup comes through without a per-call override.
    expect(input.className).toMatch(/h-11/)
    expect(input.className).toMatch(/border-input/)
    expect(input.className).toMatch(/text-base/)
  })

  it('carries the 4-ring sage focus style from the mockup', () => {
    render(<Input placeholder="p" />)
    const input = screen.getByPlaceholderText('p')
    // DS8 Sage Modern: the focus ring leans on the sage --ring token at
    // 25% alpha, translated to Tailwind's focus-visible:ring-4 +
    // focus-visible:ring-ring/25.
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
