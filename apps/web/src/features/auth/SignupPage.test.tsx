import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { SignupPage } from './SignupPage'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function renderSignup(search: string = '?token=the-token') {
  return render(
    <MemoryRouter initialEntries={[`/signup${search}`]}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/login" element={<div data-testid="login">Anmelden</div>} />
        </Route>
        <Route path="/" element={<div data-testid="home">Zuhause</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<SignupPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('renders the hero headline and card submit button', async () => {
    server.use(
      http.get('/api/invites/app/:token', () =>
        HttpResponse.json({
          valid: true,
          expiresAt: '2030-01-01T00:00:00Z',
          inviterDisplayName: 'Oma',
        }),
      ),
    )

    renderSignup()
    expect(
      screen.getByRole('heading', { level: 1, name: /willkommen in der familie/i }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^registrieren$/i })).toBeInTheDocument()
  })

  it('fetches invite preview and shows the inviter name in the kicker', async () => {
    server.use(
      http.get('/api/invites/app/:token', ({ params }) => {
        expect(params.token).toBe('the-token')
        return HttpResponse.json({
          valid: true,
          expiresAt: '2030-01-01T00:00:00Z',
          inviterDisplayName: 'Tante Herta',
        })
      }),
    )

    renderSignup()

    // Both the kicker pill and the italic tagline reference the inviter.
    const mentions = await screen.findAllByText(/tante herta/i)
    expect(mentions.length).toBeGreaterThanOrEqual(1)
    expect(mentions[0]).toHaveTextContent(/tante herta/i)
  })

  it('shows an error when the invite is invalid', async () => {
    server.use(
      http.get('/api/invites/app/:token', () =>
        HttpResponse.json({ valid: false, expiresAt: '2020-01-01T00:00:00Z' }),
      ),
    )

    renderSignup('?token=expired')

    expect(await screen.findByRole('alert')).toHaveTextContent(/einladung/i)
  })

  it('shows an error when the invite token is missing', async () => {
    renderSignup('?token=')

    expect(await screen.findByRole('alert')).toHaveTextContent(/einladung/i)
  })

  it('links back to /login for returning users', async () => {
    server.use(
      http.get('/api/invites/app/:token', () =>
        HttpResponse.json({
          valid: true,
          expiresAt: '2030-01-01T00:00:00Z',
          inviterDisplayName: 'Opa',
        }),
      ),
    )
    renderSignup()

    // The card footer offers a link to /login.
    const loginLink = await screen.findByRole('link', { name: /anmelden/i })
    expect(loginLink).toHaveAttribute('href', '/login')
  })

  it('submits the signup form and redirects to /', async () => {
    server.use(
      http.get('/api/invites/app/:token', () =>
        HttpResponse.json({ valid: true, expiresAt: '2030-01-01T00:00:00Z', inviterDisplayName: 'Oma' }),
      ),
      http.post('/api/auth/signup', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('token')).toBe('the-token')
        return HttpResponse.json({
          accessToken: 'fresh',
          user: { id: 'u1', email: 'new@example.com', displayName: 'Neuer Nutzer', role: 'User' },
        })
      }),
    )

    const user = userEvent.setup()
    renderSignup()

    // Wait for invite preview so the form is enabled.
    await screen.findAllByText(/oma/i)

    await user.type(screen.getByLabelText(/anzeigename/i), 'Neuer Nutzer')
    await user.type(screen.getByLabelText(/e-mail/i), 'new@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^registrieren$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
    expect(useAuthStore.getState().user?.email).toBe('new@example.com')
  })
})
