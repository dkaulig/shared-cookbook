import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './badge'
import { badgeVariants } from './badge-variants'

describe('<Badge />', () => {
  it('renders its children inside a span by default', () => {
    render(<Badge>15 min</Badge>)
    const badge = screen.getByText('15 min')
    expect(badge.tagName).toBe('SPAN')
  })

  it('applies the default (secondary/amber) variant classes', () => {
    render(<Badge data-testid="b">Admin</Badge>)
    const badge = screen.getByTestId('b')
    // Mockup `.mini-tag` is amber-100 bg + amber-800 text, mapped to
    // the shadcn secondary + secondary-foreground tokens.
    expect(badge.className).toMatch(/bg-secondary/)
    expect(badge.className).toMatch(/text-secondary-foreground/)
  })

  it('supports the mini-tag variant matching the mockup chip', () => {
    render(
      <Badge variant="mini" data-testid="b">
        Vegan
      </Badge>,
    )
    const badge = screen.getByTestId('b')
    // Mockup mini-tag: 11 px text, 1.5 px/0.5 py, medium weight.
    expect(badge.className).toMatch(/text-\[11px\]/)
    expect(badge.className).toMatch(/font-medium/)
  })

  it('supports the destructive variant', () => {
    render(
      <Badge variant="destructive" data-testid="b">
        Fehler
      </Badge>,
    )
    expect(screen.getByTestId('b').className).toMatch(/bg-destructive/)
  })

  it('merges caller-supplied className', () => {
    render(
      <Badge className="custom-badge" data-testid="b">
        x
      </Badge>,
    )
    expect(screen.getByTestId('b').className).toMatch(/custom-badge/)
  })

  it('exposes a badgeVariants helper that returns class strings', () => {
    const classes = badgeVariants({ variant: 'outline' })
    expect(typeof classes).toBe('string')
    expect(classes).toMatch(/border/)
  })
})
