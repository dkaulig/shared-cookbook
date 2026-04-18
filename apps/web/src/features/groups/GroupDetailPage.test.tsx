import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupDetail } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { GroupDetailPage } from './GroupDetailPage'

const detail: GroupDetail = {
  id: 'g1',
  name: 'Example Family',
  description: 'Unsere Lieblinge',
  coverImageUrl: null,
  defaultServings: 4,
  isPrivateCollection: false,
  memberCount: 2,
  myRole: 'Admin',
  members: [
    { userId: 'u1', displayName: 'Alice', role: 'Admin', joinedAt: '2026-04-18T00:00:00Z' },
    { userId: 'u2', displayName: 'Bob', role: 'Member', joinedAt: '2026-04-18T00:00:00Z' },
  ],
}

function withProviders(path: string): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } },
  })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/groups/:id" element={<GroupDetailPage />} />
          <Route path="/groups" element={<div data-testid="groups-list">list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('<GroupDetailPage />', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: 't',
      user: { id: 'u1', email: 'u1@ex.de', displayName: 'Alice', role: 'User' },
    })
    // Default search response (empty list) so the list rendering doesn't
    // trigger network errors unrelated to the skeleton assertion.
    server.use(
      http.get('/api/groups/:id/recipes/search', () =>
        HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 20 }),
      ),
    )
  })

  it('renders skeleton placeholders while the detail query is loading', async () => {
    let resolveDetail: ((value: GroupDetail) => void) | undefined
    server.use(
      http.get('/api/groups/g1', () => new Promise<Response>((resolve) => {
        resolveDetail = (body) => resolve(HttpResponse.json(body))
      })),
    )

    render(withProviders('/groups/g1'))

    const skeletons = await screen.findAllByRole('status')
    expect(skeletons.length).toBeGreaterThan(2)

    resolveDetail?.(detail)
    expect(await screen.findByRole('heading', { name: 'Example Family' })).toBeInTheDocument()
  })
})
