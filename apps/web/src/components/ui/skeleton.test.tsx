import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Skeleton } from './skeleton'

describe('<Skeleton />', () => {
  it('renders a pulsing placeholder with role="status"', () => {
    render(<Skeleton data-testid="sk" aria-label="Lade Inhalt" />)
    const node = screen.getByTestId('sk')
    expect(node.getAttribute('role')).toBe('status')
    // Pulse class is the whole point — regression guard against
    // someone swapping the utility and losing the shimmer.
    expect(node.className).toMatch(/animate-pulse/)
  })

  it('uses the warm-palette muted token (not hardcoded stone greys)', () => {
    // DS7: the skeleton has to auto-adopt the Warme-Küche palette so
    // loading states feel coherent with the rest of the cream surface.
    // Pin `bg-muted` (which maps to `--muted: #F5F5F4 stone-100` in
    // light mode + the stone-800 equivalent in `.dark`) instead of a
    // hardcoded `bg-stone-200/*` utility that breaks in dark mode and
    // looks cold on cream.
    render(<Skeleton data-testid="sk" />)
    const node = screen.getByTestId('sk')
    expect(node.className).toMatch(/bg-muted/)
    expect(node.className).not.toMatch(/bg-stone-/)
  })

  it('forwards className and children for customization', () => {
    render(
      <Skeleton className="h-10 w-20" data-testid="sk">
        <span>hidden</span>
      </Skeleton>,
    )
    const node = screen.getByTestId('sk')
    expect(node.className).toMatch(/animate-pulse/)
    expect(node.className).toMatch(/h-10/)
    expect(node.className).toMatch(/w-20/)
  })
})
