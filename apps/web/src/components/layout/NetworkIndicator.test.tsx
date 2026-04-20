import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NetworkIndicator } from './NetworkIndicator'
import {
  dispatchSwMessage,
  installServiceWorkerStub,
  uninstallServiceWorkerStub,
} from '@/test/serviceWorkerStub'

function stubOnLine(value: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    value,
    configurable: true,
    writable: true,
  })
}

describe('<NetworkIndicator />', () => {
  beforeEach(() => {
    installServiceWorkerStub()
    stubOnLine(true)
  })
  afterEach(() => {
    stubOnLine(true)
    uninstallServiceWorkerStub()
  })

  it('renders an empty sr-only host when online with no pending replays', () => {
    const { container } = render(<NetworkIndicator />)
    const host = container.querySelector('[data-testid="network-indicator-idle"]')
    expect(host).not.toBeNull()
    expect(host).toHaveAttribute('role', 'status')
    expect(host).toHaveAttribute('aria-live', 'polite')
    // No user-visible "Offline" / "wartend" text in the happy state.
    expect(screen.queryByText(/offline/i)).toBeNull()
    expect(screen.queryByText(/wartend/i)).toBeNull()
  })

  it('shows the Offline pill when navigator reports offline', () => {
    stubOnLine(false)
    render(<NetworkIndicator />)
    const pill = screen.getByTestId('network-indicator')
    expect(pill).toHaveAttribute('role', 'status')
    expect(pill).toHaveAttribute('aria-live', 'polite')
    expect(pill).toHaveTextContent(/offline/i)
  })

  it('shows "N wartend" when online and pendingReplayCount > 0', () => {
    render(<NetworkIndicator />)
    act(() => {
      dispatchSwMessage({ type: 'fk-mutation-queued' })
      dispatchSwMessage({ type: 'fk-mutation-queued' })
    })
    const pill = screen.getByTestId('network-indicator')
    expect(pill).toHaveTextContent(/2 wartend/i)
    expect(pill).toHaveAttribute('role', 'status')
    expect(pill).toHaveAttribute('aria-live', 'polite')
  })

  it('returns to the idle empty host after a successful replay', () => {
    const { container } = render(<NetworkIndicator />)
    act(() => {
      dispatchSwMessage({ type: 'fk-mutation-queued' })
    })
    expect(screen.getByTestId('network-indicator')).toHaveTextContent(
      /1 wartend/i,
    )

    act(() => {
      dispatchSwMessage({ type: 'fk-mutation-replayed', count: 1 })
    })
    // Back to idle → pill disappears, idle host remains.
    expect(screen.queryByTestId('network-indicator')).toBeNull()
    expect(
      container.querySelector('[data-testid="network-indicator-idle"]'),
    ).not.toBeNull()
  })
})
