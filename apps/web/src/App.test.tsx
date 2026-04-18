import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import App from './App.tsx'
import { useAuthStore } from './features/auth/authStore.ts'
import { server } from './test/msw/server.ts'

describe('<App />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('redirects to /login when silent refresh fails', async () => {
    server.use(http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })))

    render(<App />)

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login')
    })
    expect(screen.getByRole('heading', { level: 1, name: /anmelden/i })).toBeInTheDocument()
  })

  it('renders the Familien-Kochbuch home when silent refresh succeeds', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Oma', role: 'User' },
        }),
      ),
    )

    render(<App />)

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: /familien-kochbuch/i }),
      ).toBeInTheDocument()
    })
    expect(screen.getByText(/oma/i)).toBeInTheDocument()
  })
})
