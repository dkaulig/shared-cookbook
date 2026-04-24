import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthLayout } from './AuthLayout'
import { LoginPage } from './LoginPage'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'

function LocationProbe() {
  const loc = useLocation()
  // Data-only probe — never renders the raw search string as text so
  // hostile ?next= payloads never reach the DOM via queryByText.
  return (
    <div
      data-testid="location"
      data-pathname={loc.pathname}
      data-search={loc.search}
    />
  )
}

function renderLogin(initialEntry = '/login') {
  // useAuth() now depends on a QueryClientProvider (needed so logout can
  // purge the cache — see useAuth.test.tsx). LoginPage itself never
  // reads the cache, but the provider must still exist for the hook.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LocationProbe />
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<div data-testid="signup">registrieren</div>} />
            <Route path="/forgot-password" element={<div data-testid="forgot">vergessen</div>} />
          </Route>
          <Route path="/" element={<div data-testid="home">Zuhause</div>} />
          <Route
            path="/share-target"
            element={<div data-testid="share-target">share-target</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
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
    // The shadcn CardTitle renders as <h3> (DS1 default).
    expect(
      screen.getByRole('heading', { level: 3, name: /^anmelden$/i }),
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

  // REL-3f — backend error-codes route through the localised errors.json
  // copy; the raw English Dev-Message never leaks verbatim.
  it('on 401 surfaces the localised errors:invalid_credentials copy', async () => {
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          {
            code: 'invalid_credentials',
            message: 'Invalid email or password.',
            status: 401,
          },
          { status: 401 },
        ),
      ),
    )

    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
    await user.type(screen.getByLabelText(/passwort/i), 'wrong')
    await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/E-Mail oder Passwort ist nicht korrekt/i)
    expect(alert).not.toHaveTextContent(/Invalid email or password/)
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

  /**
   * SHARE-0b — `/login?next=` follow-through.
   *
   * When an unauthenticated user arrives at `/share-target?…` (via the
   * iOS/Android share sheet), `ShareTargetPage` bounces them to
   * `/login?next=<encoded /share-target path>`. After successful login
   * we must land them back on `/share-target` (with original query
   * intact) so the share payload isn't lost.
   *
   * Security: the `next` param is attacker-controlled. A malicious
   * share-sheet entry could craft `?next=//evil.com` (protocol-relative)
   * or `?next=https://evil.com` (absolute) and turn the login flow into
   * an open redirect. Allowlist: only same-origin relative paths —
   * starts with `/`, not `//`, no scheme.
   */
  describe('SHARE-0b — post-login ?next= redirect', () => {
    function setupLoginSuccess() {
      server.use(
        http.post('/api/auth/login', () =>
          HttpResponse.json({
            accessToken: 'tok',
            user: {
              id: 'u1',
              email: 'user@example.com',
              displayName: 'Nutzer',
              role: 'User',
            },
          }),
        ),
      )
    }

    it('redirects to a same-origin ?next= path after successful login', async () => {
      setupLoginSuccess()
      const user = userEvent.setup()
      renderLogin(
        '/login?next=' + encodeURIComponent('/share-target?url=https://fb.com/x'),
      )

      await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
      await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

      await waitFor(() => {
        expect(screen.getByTestId('share-target')).toBeInTheDocument()
      })
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/share-target')
      // React Router decodes the query param once en-route; the assertion
      // matches the decoded form the client-side component receives.
      expect(loc.getAttribute('data-search')).toBe('?url=https://fb.com/x')
    })

    it('falls back to "/" when ?next= is protocol-relative (//evil.com)', async () => {
      setupLoginSuccess()
      const user = userEvent.setup()
      renderLogin('/login?next=' + encodeURIComponent('//evil.com/steal'))

      await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
      await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

      await waitFor(() => {
        expect(screen.getByTestId('home')).toBeInTheDocument()
      })
      const loc = screen.getByTestId('location')
      expect(loc.getAttribute('data-pathname')).toBe('/')
    })

    it('falls back to "/" when ?next= is an absolute https URL', async () => {
      setupLoginSuccess()
      const user = userEvent.setup()
      renderLogin(
        '/login?next=' + encodeURIComponent('https://evil.com/steal'),
      )

      await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
      await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

      await waitFor(() => {
        expect(screen.getByTestId('home')).toBeInTheDocument()
      })
      expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
        '/',
      )
    })

    it('falls back to "/" when ?next= is absent (original SHARE-0 behaviour preserved)', async () => {
      setupLoginSuccess()
      const user = userEvent.setup()
      renderLogin('/login')

      await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
      await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

      await waitFor(() => {
        expect(screen.getByTestId('home')).toBeInTheDocument()
      })
      expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
        '/',
      )
    })

    it('falls back to "/" when ?next= is a javascript: scheme payload', async () => {
      setupLoginSuccess()
      const user = userEvent.setup()
      renderLogin('/login?next=' + encodeURIComponent('javascript:alert(1)'))

      await user.type(screen.getByLabelText(/e-mail/i), 'user@example.com')
      await user.type(screen.getByLabelText(/passwort/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^anmelden$/i }))

      await waitFor(() => {
        expect(screen.getByTestId('home')).toBeInTheDocument()
      })
      expect(screen.getByTestId('location').getAttribute('data-pathname')).toBe(
        '/',
      )
    })
  })
})
