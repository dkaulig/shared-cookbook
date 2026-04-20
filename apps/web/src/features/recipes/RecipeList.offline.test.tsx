import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type {
  RecipeSearchParams,
  RecipeSearchResult,
  RecipeSummaryDto,
} from '@familien-kochbuch/shared'
import { RecipeList } from './RecipeList'
import { searchQueryKeys } from '@/features/search/hooks'

/**
 * OFF1 — offline smoke.
 *
 * Verifies the OFF1 happy path end-to-end from a component's POV: when
 * the browser is offline AND the query cache already holds data (as it
 * would right after a `PersistQueryClientProvider` hydrate), the list
 * renders from cache without issuing a network request.
 *
 * MSW's `onUnhandledRequest: 'error'` in `src/test/setup.ts` already
 * asserts "no network call" — any `fetch` to `/api/search/...` would
 * fail the test run. We only need to seed the cache and assert the
 * list items appear.
 */
describe('RecipeList offline rendering (OFF1)', () => {
  it('renders from TanStack cache when navigator.onLine is false', () => {
    const onlineSpy = vi
      .spyOn(window.navigator, 'onLine', 'get')
      .mockReturnValue(false)

    try {
      const groupId = 'g1'
      const filters: RecipeSearchParams = {}
      const recipe: RecipeSummaryDto = {
        id: 'r1',
        groupId,
        title: 'Omas Kartoffelsuppe',
        description: 'Mit Majoran',
        photo: null,
        tagIds: [],
        createdByDisplayName: 'Oma',
        updatedAt: '2026-04-19T12:00:00Z',
        avgRating: 4.6,
        ratingCount: 3,
        myStars: null,
      }
      const cached: RecipeSearchResult = {
        items: [recipe],
        page: 1,
        pageSize: 20,
        total: 1,
      }

      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      })
      client.setQueryData(searchQueryKeys.forGroup(groupId, filters), cached)

      function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>
      }

      render(
        <MemoryRouter>
          <RecipeList groupId={groupId} />
        </MemoryRouter>,
        { wrapper: Wrapper },
      )

      // Cached title is immediately visible — no "Lade Rezepte …" state,
      // and no unhandled MSW request was logged (setup.ts errors on any).
      expect(screen.getByRole('heading', { name: /omas kartoffelsuppe/i })).toBeInTheDocument()
      expect(screen.queryByText(/lade rezepte/i)).not.toBeInTheDocument()
      expect(window.navigator.onLine).toBe(false)
    } finally {
      onlineSpy.mockRestore()
    }
  })
})
