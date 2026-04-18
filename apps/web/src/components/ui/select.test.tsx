import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Select } from './select'

describe('<Select />', () => {
  it('renders a native <select> with Sage Modern tokens', () => {
    render(
      <Select data-testid="sel" defaultValue="b">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>,
    )
    const select = screen.getByTestId('sel')
    expect(select.tagName).toBe('SELECT')
    expect(select.className).toMatch(/border-input/)
    expect(select.className).toMatch(/bg-background/)
    expect(select.className).toMatch(/h-11/)
  })

  it('uses the sage 4-ring focus state', () => {
    render(
      <Select data-testid="sel">
        <option>Eins</option>
      </Select>,
    )
    const select = screen.getByTestId('sel')
    expect(select.className).toMatch(/focus-visible:ring-4/)
    expect(select.className).toMatch(/focus-visible:ring-ring/)
  })

  it('renders children <option> elements', () => {
    render(
      <Select data-testid="sel" defaultValue="b">
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </Select>,
    )
    const select = screen.getByTestId('sel') as HTMLSelectElement
    expect(select.options.length).toBe(2)
    expect(select.value).toBe('b')
  })

  it('merges caller-supplied className and forwards name', () => {
    render(
      <Select data-testid="sel" className="custom-sel" name="rolle">
        <option>X</option>
      </Select>,
    )
    const select = screen.getByTestId('sel') as HTMLSelectElement
    expect(select.className).toMatch(/custom-sel/)
    expect(select.name).toBe('rolle')
  })
})
