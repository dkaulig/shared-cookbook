import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ActiveFilterChips } from './ActiveFilterChips'

/**
 * DS4 — active-filter chip row at the page level. Renders one chip per
 * applied filter (tag / min-rating / max-prep / creator) plus a "Filter
 * zurücksetzen" bulk-clear link.
 */

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/groups/g1/tags', () =>
      HttpResponse.json([
        { id: 't1', name: 'schnell', category: 'Aufwand', isGlobal: true, groupId: null, createdByUserId: null },
        { id: 't2', name: 'vegan', category: 'Diaet', isGlobal: true, groupId: null, createdByUserId: null },
      ]),
    ),
    http.get('/api/groups/g1/members', () =>
      HttpResponse.json([
        { userId: 'u1', displayName: 'Ich', role: 'Admin', joinedAt: '2026-01-01T00:00:00Z' },
      ]),
    ),
  )
})

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location-probe">{loc.pathname}{loc.search}</div>
}

function renderChips(initial = '/groups/g1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route
            path="/groups/:groupId/*"
            element={
              <>
                {children}
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return render(<ActiveFilterChips groupId="g1" />, { wrapper })
}

describe('<ActiveFilterChips />', () => {
  it('renders nothing when no filters are active', () => {
    const { container } = renderChips('/groups/g1')
    // Only the LocationProbe remains — no chip row.
    expect(container.querySelector('button')).toBeNull()
  })

  it('renders a tag chip + × button that removes the tag from the URL', async () => {
    renderChips('/groups/g1?tags=t1')
    const removeBtn = await screen.findByRole('button', { name: /schnell entfernen/i })
    expect(removeBtn).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(removeBtn)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('tags=t1')
    })
  })

  it('renders a "≥ N Sterne" chip for minRating and removes on click', async () => {
    renderChips('/groups/g1?minRating=4')
    const removeBtn = await screen.findByRole('button', { name: /4 Sterne entfernen/i })

    const user = userEvent.setup()
    await user.click(removeBtn)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('minRating=')
    })
  })

  it('renders a "≤ N Min" chip for maxPrepTime and removes on click', async () => {
    renderChips('/groups/g1?maxPrepTime=60')
    const removeBtn = await screen.findByRole('button', { name: /60 Min entfernen/i })

    const user = userEvent.setup()
    await user.click(removeBtn)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('maxPrepTime=')
    })
  })

  it('"Filter zurücksetzen" wipes every filter in one click', async () => {
    renderChips('/groups/g1?tags=t1&minRating=4&maxPrepTime=60')
    const clear = await screen.findByRole('button', { name: /Filter zurücksetzen/i })

    const user = userEvent.setup()
    await user.click(clear)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('tags=')
      expect(loc).not.toContain('minRating=')
      expect(loc).not.toContain('maxPrepTime=')
    })
  })

  it('preserves the q text when clearing chips (users may want to keep their search)', async () => {
    renderChips('/groups/g1?q=Nudeln&tags=t1')
    const clear = await screen.findByRole('button', { name: /Filter zurücksetzen/i })

    const user = userEvent.setup()
    await user.click(clear)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('q=Nudeln')
      expect(loc).not.toContain('tags=')
    })
  })
})
