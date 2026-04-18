import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
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
  it('typing into the text search updates the URL', async () => {
    renderPanel()
    const input = await screen.findByLabelText(/Suche/i) as HTMLInputElement
    const user = userEvent.setup()
    await user.type(input, 'Nudeln')

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('q=Nudeln')
    })
  })

  it('clicking a tag chip toggles tag in URL', async () => {
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

  it('clicking Zufall fetches random and navigates', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/random', () =>
        HttpResponse.json({ recipeId: 'r42' }),
      ),
    )

    renderPanel()
    const user = userEvent.setup()
    const zufall = await screen.findByRole('button', { name: /Zufall/i })
    await user.click(zufall)

    await waitFor(() => {
      const loc = screen.getByTestId('location-probe').textContent ?? ''
      expect(loc).toContain('/groups/g1/recipes/r42')
    })
  })

  it('random with no match surfaces a German message', async () => {
    server.use(
      http.get('/api/groups/g1/recipes/random', () =>
        HttpResponse.json({ recipeId: null }),
      ),
    )

    renderPanel()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Zufall/i }))

    await waitFor(() =>
      expect(screen.getByText(/Kein Rezept passt/i)).toBeInTheDocument(),
    )
  })
})
