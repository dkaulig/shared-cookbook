import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBackgroundSyncMessage } from './useBackgroundSyncMessage'
import {
  dispatchSwMessage,
  installServiceWorkerStub,
  uninstallServiceWorkerStub,
} from '@/test/serviceWorkerStub'

function withClient(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useBackgroundSyncMessage', () => {
  beforeEach(() => {
    installServiceWorkerStub()
  })
  afterEach(() => {
    uninstallServiceWorkerStub()
  })

  it('invalidates all four mutation-affected query prefixes on fk-mutation-replayed', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    renderHook(() => useBackgroundSyncMessage(), {
      wrapper: withClient(client),
    })

    act(() => {
      dispatchSwMessage({ type: 'fk-mutation-replayed', count: 3 })
    })

    // The order matches the call order in the hook; using
    // `expect.objectContaining` keeps the assertion robust to whatever
    // defaults the QueryClient fills in.
    const calls = spy.mock.calls.map((c) => c[0])
    expect(calls).toContainEqual(
      expect.objectContaining({ queryKey: ['recipes'] }),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ queryKey: ['mealplan'] }),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ queryKey: ['shoppinglist'] }),
    )
    expect(calls).toContainEqual(
      expect.objectContaining({ queryKey: ['ratings'] }),
    )
  })

  it('ignores SW messages of other types', () => {
    const client = new QueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')

    renderHook(() => useBackgroundSyncMessage(), {
      wrapper: withClient(client),
    })

    act(() => {
      dispatchSwMessage({ type: 'fk-mutation-queued' })
      dispatchSwMessage({ type: 'some-other-message' })
      dispatchSwMessage(null)
    })

    expect(spy).not.toHaveBeenCalled()
  })
})
