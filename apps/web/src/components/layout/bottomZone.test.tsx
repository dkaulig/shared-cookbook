import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BottomZoneProvider, useBottomZoneSlot } from './bottomZone'
import { BottomNav } from './BottomNav'

/**
 * BUG-036 — Bottom-Zone provider + hook contract.
 *
 *   - `useBottomZoneSlot(node)` pushes `node` into the Provider's slot
 *     state on mount, and clears it on unmount.
 *   - BottomNav consumes the slot via `useBottomZoneConsumer` and
 *     renders it inside `data-testid="bottom-zone-slot"` ABOVE the
 *     nav row.
 *   - Outside a Provider the hook is a silent no-op (tests render
 *     unwrapped components frequently — the hook must not throw).
 */

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BottomZoneProvider>
          {children}
          <BottomNav />
        </BottomZoneProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function SlotMounter({ children }: { children: ReactNode }) {
  useBottomZoneSlot(children, [children])
  return null
}

describe('BottomZoneProvider + useBottomZoneSlot', () => {
  it('renders the slot node inside data-testid="bottom-zone-slot" on mount', async () => {
    render(
      <Wrapper>
        <SlotMounter>
          <span data-testid="payload">ping</span>
        </SlotMounter>
      </Wrapper>,
    )
    const slot = await screen.findByTestId('bottom-zone-slot')
    expect(slot).toBeInTheDocument()
    expect(screen.getByTestId('payload')).toBeInTheDocument()
    expect(slot.textContent).toContain('ping')
  })

  it('clears the slot when the mounting component unmounts', async () => {
    function Harness({ mounted }: { mounted: boolean }) {
      return (
        <Wrapper>
          {mounted && (
            <SlotMounter>
              <span data-testid="payload">hi</span>
            </SlotMounter>
          )}
        </Wrapper>
      )
    }
    const { rerender } = render(<Harness mounted={true} />)
    // Initial render: slot is present.
    await screen.findByTestId('bottom-zone-slot')

    // Unmount the SlotMounter → slot should clear on the next render.
    rerender(<Harness mounted={false} />)

    // The slot row is conditional on a non-null node in context, so it
    // disappears from the DOM entirely.
    expect(screen.queryByTestId('bottom-zone-slot')).not.toBeInTheDocument()
    expect(screen.queryByTestId('payload')).not.toBeInTheDocument()
  })

  it('is a silent no-op when there is no BottomZoneProvider in the tree', () => {
    // Should neither throw nor render any slot UI. The component
    // mounts → useBottomZoneSlot sees `set == null` → early returns.
    function NoProvider() {
      useBottomZoneSlot(<span>ignored</span>, [])
      return <div data-testid="no-provider">ok</div>
    }
    expect(() => render(<NoProvider />)).not.toThrow()
    expect(screen.getByTestId('no-provider')).toBeInTheDocument()
    expect(screen.queryByTestId('bottom-zone-slot')).not.toBeInTheDocument()
  })

  it('swaps the slot content when the mounting component re-renders with a new node', async () => {
    function Harness({ label }: { label: string }) {
      return (
        <Wrapper>
          <SlotMounter>
            <span data-testid="payload">{label}</span>
          </SlotMounter>
        </Wrapper>
      )
    }
    const { rerender } = render(<Harness label="first" />)
    expect((await screen.findByTestId('payload')).textContent).toBe('first')

    rerender(<Harness label="second" />)
    expect((await screen.findByTestId('payload')).textContent).toBe('second')
  })
})
