import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChefHatLogo } from './ChefHatLogo'

describe('<ChefHatLogo />', () => {
  it('renders an SVG with the default 22 px size', () => {
    render(<ChefHatLogo data-testid="logo" />)
    const svg = screen.getByTestId('logo')
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.getAttribute('width')).toBe('22')
    expect(svg.getAttribute('height')).toBe('22')
  })

  it('respects a custom size prop', () => {
    render(<ChefHatLogo size={32} data-testid="logo" />)
    const svg = screen.getByTestId('logo')
    expect(svg.getAttribute('width')).toBe('32')
    expect(svg.getAttribute('height')).toBe('32')
  })

  it('merges a caller-supplied className', () => {
    render(<ChefHatLogo className="custom-logo" data-testid="logo" />)
    expect(screen.getByTestId('logo').getAttribute('class')).toMatch(/custom-logo/)
  })

  it('draws the chef-hat outline path from the mockup', () => {
    const { container } = render(<ChefHatLogo />)
    const paths = container.querySelectorAll('path')
    // Mockup has two path elements: the hat silhouette + the brim stroke.
    expect(paths.length).toBe(2)
    expect(paths[0].getAttribute('d')).toMatch(/M17 21a1 1 0 0 0/)
    expect(paths[1].getAttribute('d')).toBe('M6 17h12')
  })

  it('uses currentColor stroke so the surrounding text color applies', () => {
    const { container } = render(<ChefHatLogo />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('fill')).toBe('none')
  })
})
