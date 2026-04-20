import { beforeEach, describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, useQuery } from '@tanstack/react-query'
import {
  PersistQueryClientProvider,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client'
import { clear } from 'idb-keyval'
import {
  MAX_AGE_MS,
  persister,
  shouldDehydrateQuery,
} from './lib/queryPersister'

/**
 * OFF1 — integration test for `PersistQueryClientProvider` itself.
 *
 * Mirrors the wiring in `main.tsx` — exercises the buster-change path
 * to prove a deploy (new VITE_APP_VERSION) actually invalidates stale
 * IDB cache when the user reloads. We pre-seed IDB with the non-
 * throttled `persistQueryClientSave` helper because the provider's own
 * writes go through a 1 s throttle that's flaky to await in jsdom.
 */

interface Cached {
  value: string
}

function Probe({ queryKey }: { queryKey: readonly unknown[] }) {
  // `enabled: false` means the only way `data` shows up is via
  // hydration — no queryFn firing, no refetch, no network.
  const q = useQuery<Cached>({
    queryKey,
    queryFn: async () => ({ value: 'fetched' }),
    enabled: false,
  })
  return <span data-testid="probe">{q.data ? q.data.value : 'empty'}</span>
}

describe('PersistQueryClientProvider buster invalidation', () => {
  beforeEach(async () => {
    await clear()
  })

  it('hydrates a fresh client when buster matches', async () => {
    // Pre-seed IDB synchronously via persistQueryClientSave — skips the
    // 1 s writer throttle the provider uses internally.
    const seed = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seed.setQueryData(['recipes', 'group', 'g1'], { value: 'cached' })
    await persistQueryClientSave({
      queryClient: seed,
      persister,
      buster: 'v1',
      dehydrateOptions: { shouldDehydrateQuery },
    })

    // Fresh mount — provider restores from IDB because buster matches.
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { getByTestId } = render(
      <PersistQueryClientProvider
        client={fresh}
        persistOptions={{
          persister,
          buster: 'v1',
          maxAge: MAX_AGE_MS,
          dehydrateOptions: { shouldDehydrateQuery },
        }}
      >
        <Probe queryKey={['recipes', 'group', 'g1']} />
      </PersistQueryClientProvider>,
    )

    await waitFor(() => {
      expect(getByTestId('probe').textContent).toBe('cached')
    })
  })

  it('drops stale cache when buster changes between mounts', async () => {
    const seed = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seed.setQueryData(['recipes', 'group', 'g1'], { value: 'cached' })
    await persistQueryClientSave({
      queryClient: seed,
      persister,
      buster: 'v1',
      dehydrateOptions: { shouldDehydrateQuery },
    })

    // Mount with a DIFFERENT buster — simulates a deploy bumping
    // VITE_APP_VERSION. The provider's restore path should reject the
    // stale payload and call persister.removeClient().
    const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { getByTestId } = render(
      <PersistQueryClientProvider
        client={fresh}
        persistOptions={{
          persister,
          buster: 'v2',
          maxAge: MAX_AGE_MS,
          dehydrateOptions: { shouldDehydrateQuery },
        }}
      >
        <Probe queryKey={['recipes', 'group', 'g1']} />
      </PersistQueryClientProvider>,
    )

    // Wait for hydration microtask to settle; the probe must stay
    // empty because v1 cache was discarded.
    await new Promise((r) => setTimeout(r, 10))
    expect(getByTestId('probe').textContent).toBe('empty')
  })
})
