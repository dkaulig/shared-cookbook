import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ProfilStub } from './ProfilStub'

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/profil']}>
          <Routes>
            <Route path="/profil" element={children} />
            <Route path="/login" element={<div data-testid="login">login</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ProfilStub />, { wrapper: Wrapper })
}

describe('<ProfilStub />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'david@kaulig.de',
      displayName: 'David',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the serif-typeset heading "Mein Profil"', () => {
    renderPage()
    const heading = screen.getByRole('heading', { level: 1, name: /mein profil/i })
    expect(heading).toBeInTheDocument()
    expect(heading.className).toMatch(/font-serif/)
  })

  it('shows the signed-in display name and email', () => {
    renderPage()
    expect(screen.getByText(/david/i)).toBeInTheDocument()
    expect(screen.getByText(/david@kaulig\.de/i)).toBeInTheDocument()
  })

  it('shows the Abmelden button and clears auth state when clicked', async () => {
    server.use(http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })))
    renderPage()

    const user = userEvent.setup()
    const logout = screen.getByRole('button', { name: /abmelden/i })
    await user.click(logout)

    await waitFor(() => {
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
    })
  })

  it('opens the InviteDialog when "Jemanden einladen" is clicked', async () => {
    renderPage()
    const user = userEvent.setup()

    expect(screen.queryByRole('dialog', { name: /jemanden einladen/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /jemanden einladen/i }))

    const dialog = await screen.findByRole('dialog', { name: /jemanden einladen/i })
    expect(dialog).toBeInTheDocument()
  })
})
