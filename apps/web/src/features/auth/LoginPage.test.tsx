import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { LoginPage } from './LoginPage'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<div data-testid="signup">registrieren</div>} />
          <Route path="/forgot-password" element={<div data-testid="forgot">vergessen</div>} />
        </Route>
        <Route path="/" element={<div data-testid="home">Zuhause</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<LoginPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().clear()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('renders the hero headline and card title matching the mockup', () => {
    renderLogin()
    expect(
      screen.getByRole('heading', { level: 1, name: /was kochen wir heute\?/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: /^anmelden$/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^anmelden$/i })).toBeInTheDocument()
  })

  it('renders the "Willkommen zurück" kicker and German card subtitle', () => {
    renderLogin()
    expect(screen.getByText(/willkommen zurück/i)).toBeInTheDocument()
    expect(screen.getByText(/schön, dass du wieder da bist/i)).toBeInTheDocument()
  })

  it('renders the remember-me checkbox with the 30-day label', () => {
    renderLogin()
    const checkbox = screen.getByLabelText(/30 tage angemeldet bleiben/i)
    expect(checkbox).toBeInTheDocument()
    expect(checkbox).toHaveAttribute('type', 'checkbox')
  })

  it('links to forgot-password and signup routes', () => {
    renderLogin()
    expect(screen.getByRole('link', { name: /passwort vergessen/i })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
    expect(screen.getByRole('link', { name: /jetzt registrieren/i })).toHaveAttribute(
      'href',
      '/signup',
    )
  })

  it('shows a German error when submitted with an empty email', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/e-mail/i)
  })

  it('shows a German error when submitted with an invalid email format', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'not-an-email')
    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/gültige e-mail/i)
  })

  it('on 401 surfaces the server German error message', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({ code: 'invalid_credentials', message: 'E-Mail oder Passwort ungültig.' }, { status: 401 }),
      ),
    )

    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'wrong')
    await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/E-Mail oder Passwort ungültig/i)
  })

  it('on 200 redirects to "/" and populates the auth store', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json({
          accessToken: 'tok',
          user: { id: 'u1', email: 'user@example.com', displayName: 'Nutzer', role: 'User' },
        }),
      ),
    )

    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })
})
