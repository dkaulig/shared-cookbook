import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function renderWithRoute(initial: string = '/protected') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route
          path="/protected"
          element={
            <ProtectedRoute>
              <div data-testid="content">Geheime Inhalte</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin-only"
          element={
            <ProtectedRoute requireAdmin>
              <div data-testid="admin-content">Nur für Admins</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div data-testid="login">Login-Seite</div>} />
        <Route path="/" element={<div data-testid="home">Startseite</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<ProtectedRoute />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('redirects to /login when silent refresh returns 401', async () => {
    server.use(http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })))

    renderWithRoute()

    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('content')).toBeNull()
  })

  it('renders children when silent refresh succeeds', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'a@b.c', displayName: 'X', role: 'User' },
        }),
      ),
    )

    renderWithRoute()

    await waitFor(() => {
      expect(screen.getByTestId('content')).toBeInTheDocument()
    })
  })

  it('shows a loading splash while the silent refresh is in flight', () => {
    // Never-resolving refresh — splash should stay visible.
    server.use(http.post('/api/auth/refresh', () => new Promise(() => {})))

    renderWithRoute()

    expect(screen.getByRole('status')).toHaveTextContent(/lade/i)
    expect(screen.queryByTestId('content')).toBeNull()
    expect(screen.queryByTestId('login')).toBeNull()
  })

  it('requireAdmin: admin user renders children', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: {
            id: 'u1',
            email: 'a@b.c',
            displayName: 'X',
            role: 'Admin',
          },
        }),
      ),
    )

    renderWithRoute('/admin-only')

    await waitFor(() => {
      expect(screen.getByTestId('admin-content')).toBeInTheDocument()
    })
  })

  it('requireAdmin: regular user is redirected to /', async () => {
    server.use(
      http.post('/api/auth/refresh', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: {
            id: 'u1',
            email: 'a@b.c',
            displayName: 'X',
            role: 'User',
          },
        }),
      ),
    )

    renderWithRoute('/admin-only')

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('admin-content')).toBeNull()
  })

  it('requireAdmin: anonymous user still bounces to /login', async () => {
    server.use(
      http.post('/api/auth/refresh', () => new HttpResponse(null, { status: 401 })),
    )

    renderWithRoute('/admin-only')

    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument()
    })
  })
})
