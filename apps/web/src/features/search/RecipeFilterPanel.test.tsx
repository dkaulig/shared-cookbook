import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeFilterPanel } from './RecipeFilterPanel'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  // Always mock tag + member lookups — the panel pulls these from TanStack.
  server.use(
    http.get('/api/groups/g1/tags', () =>
      HttpResponse.json([
        { id: 't1', name: 'schnell', category: 'Aufwand', isGlobal: true, groupId: null, createdByUserId: null },
        { id: 't2', name: 'vegan', category: 'Diaet', isGlobal: true, groupId: null, createdByUserId: null },
        { id: 't3', name: 'warm', category: 'Typ', isGlobal: true, groupId: null, createdByUserId: null },
        { id: 't4', name: 'vegetarisch', category: 'Diaet', isGlobal: true, groupId: null, createdByUserId: null },
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

function renderPanel(initial = '/groups/g1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/groups/:groupId/*" element={
            <>
              {children}
              <LocationProbe />
            </>
          } />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  )
  return render(<RecipeFilterPanel groupId="g1" />, { wrapper })
}

describe('RecipeFilterPanel', () => {
  it('clicking a tag chip toggles the tag in the URL', async () => {
    renderPanel()

    const chip = await screen.findByRole('button', { name: /schnell/i })
    const user = userEvent.setup()
    await user.click(chip)

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('tags=t1')
    })

    await user.click(chip)
    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).not.toContain('tags=t1')
    })
  })

  it('moving the min-rating slider updates the URL', async () => {
    renderPanel()
    const slider = await screen.findByLabelText(/Mindest-Bewertung/i)
    fireEvent.change(slider, { target: { value: '4' } })

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('minRating=4')
    })
  })

  it('changing the sort select updates the URL', async () => {
    renderPanel()
    const select = await screen.findByLabelText(/Sortierung/i)
    const user = userEvent.setup()
    await user.selectOptions(select, 'best_rated')

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('sort=best_rated')
    })
  })

  it('renders the group tags grouped by category', async () => {
    renderPanel()
    await screen.findByRole('button', { name: /schnell/i })
    // Category headers from the mockup: Mahlzeit / Typ / Aufwand / Diät / Küche / Custom
    // Our tag pool covers Aufwand, Diaet, Typ → those headers should render.
    expect(screen.getByText(/Aufwand/i)).toBeInTheDocument()
    expect(screen.getByText(/Typ/i)).toBeInTheDocument()
    expect(screen.getByText(/Diät/i)).toBeInTheDocument()
  })

  it('preset=quick preselects the "schnell" tag and sets maxPrepTime=30', async () => {
    renderPanel('/groups/g1?preset=quick')

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      // Preset gets consumed → `preset=` disappears; tag + maxPrepTime appear.
      expect(loc).not.toContain('preset=')
      expect(loc).toContain('tags=t1')
      expect(loc).toContain('maxPrepTime=30')
    })
  })

  it('preset=warm preselects the "warm" tag', async () => {
    renderPanel('/groups/g1?preset=warm')

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('tags=t3')
      expect(loc).not.toContain('preset=')
    })
  })

  it('preset=veggie preselects the "vegetarisch" tag', async () => {
    renderPanel('/groups/g1?preset=veggie')

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('tags=t4')
      expect(loc).not.toContain('preset=')
    })
  })

  it('reflects a pre-selected tag (URL ?tags=t1) as the "is-selected" state on the chip', async () => {
    renderPanel('/groups/g1?tags=t1')
    const chip = await screen.findByRole('button', { name: /schnell/i, pressed: true })
    expect(chip).toBeInTheDocument()
  })

  it('shows the "N ausgewählt" count when tags are selected', async () => {
    renderPanel('/groups/g1?tags=t1,t2')
    await waitFor(() => {
      expect(screen.getByText(/2 ausgewählt/i)).toBeInTheDocument()
    })
  })
})
