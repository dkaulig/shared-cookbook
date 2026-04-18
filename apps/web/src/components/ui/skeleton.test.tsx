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
