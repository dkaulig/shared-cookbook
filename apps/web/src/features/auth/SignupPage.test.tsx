import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { SignupPage } from './SignupPage'
import { useAuthStore } from './authStore'
import { server } from '@/test/msw/server'
import { createI18n } from '@/i18n'

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
  // REL-5f — init the shared i18n singleton so `classifyMutationError`
  // resolves `errors:<code>` keys to German copy. The inline field-focus
  // tests below assert the translated string, not the server-supplied
  // English dev-message.
  beforeAll(async () => {
    window.localStorage.setItem('i18nextLng', 'de')
    await createI18n()
  })

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

  // BF1 #7 — single password input invited typos that locked invitees
  // out of the invite. Mirror ResetPasswordPage's two-input pattern:
  // both fields must match before the form submits.
  it('blocks submit and surfaces a mismatch alert when passwords differ', async () => {
    server.use(
      http.get('/api/invites/app/:token', () =>
        HttpResponse.json({ valid: true, expiresAt: '2030-01-01T00:00:00Z', inviterDisplayName: 'Oma' }),
      ),
    )

    const user = userEvent.setup()
    renderSignup()

    await screen.findAllByText(/oma/i)

    await user.type(screen.getByLabelText(/anzeigename/i), 'Neuer Nutzer')
    await user.type(screen.getByLabelText(/e-mail/i), 'new@example.com')
    await user.type(screen.getByLabelText(/^passwort$/i), 'geheim123')
    await user.type(screen.getByLabelText(/passwort bestätigen/i), 'tippfehler9')
    await user.click(screen.getByRole('button', { name: /^registrieren$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /passwörter stimmen nicht überein/i,
    )
    // No redirect happened — the home stub never mounted.
    expect(screen.queryByTestId('home')).toBeNull()
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
    await user.type(screen.getByLabelText(/^passwort$/i), 'geheim123')
    await user.type(screen.getByLabelText(/passwort bestätigen/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^registrieren$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument()
    })
    expect(useAuthStore.getState().user?.email).toBe('new@example.com')
  })

  // ── REL-5f inline field-focus ───────────────────────────────────
  describe('REL-5f inline field-focus', () => {
    function validPreviewHandler() {
      return http.get('/api/invites/app/:token', () =>
        HttpResponse.json({
          valid: true,
          expiresAt: '2030-01-01T00:00:00Z',
          inviterDisplayName: 'Oma',
        }),
      )
    }

    async function fillAndSubmit() {
      const user = userEvent.setup()
      await screen.findAllByText(/oma/i)

      await user.type(screen.getByLabelText(/anzeigename/i), 'Neuer Nutzer')
      await user.type(screen.getByLabelText(/e-mail/i), 'new@example.com')
      await user.type(screen.getByLabelText(/^passwort$/i), 'geheim123')
      await user.type(screen.getByLabelText(/passwort bestätigen/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^registrieren$/i }))
      return user
    }

    it('focuses the email input + renders translated inline error when backend tags fieldName=email', async () => {
      server.use(
        validPreviewHandler(),
        http.post('/api/auth/signup', () =>
          HttpResponse.json(
            {
              code: 'email_taken',
              message: 'Email is already registered.',
              status: 400,
              fieldName: 'email',
            },
            { status: 400 },
          ),
        ),
      )
      renderSignup()
      await fillAndSubmit()

      const email = screen.getByLabelText(/e-mail/i)
      await waitFor(() => expect(email).toHaveFocus())
      // Translated copy from errors:email_taken, not raw English.
      expect(
        await screen.findByText(/bereits vergeben/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/already registered/i)).toBeNull()
    })

    it('focuses the password input when backend tags fieldName=newPassword', async () => {
      server.use(
        validPreviewHandler(),
        http.post('/api/auth/signup', () =>
          HttpResponse.json(
            {
              code: 'password_rejected',
              message: 'Password does not meet the policy.',
              status: 400,
              fieldName: 'newPassword',
            },
            { status: 400 },
          ),
        ),
      )
      renderSignup()
      await fillAndSubmit()

      const password = screen.getByLabelText(/^passwort$/i)
      await waitFor(() => expect(password).toHaveFocus())
      expect(
        await screen.findByText(/dieses passwort wurde abgelehnt/i),
      ).toBeInTheDocument()
    })

    it('fieldName=inviteToken stays as a banner without moving focus (token lives in URL)', async () => {
      server.use(
        validPreviewHandler(),
        http.post('/api/auth/signup', () =>
          HttpResponse.json(
            {
              code: 'invite_not_found',
              message: 'Invite not found.',
              status: 400,
              fieldName: 'inviteToken',
            },
            { status: 400 },
          ),
        ),
      )
      renderSignup()
      await fillAndSubmit()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/einladung wurde nicht gefunden/i)
      // No input lost/gained focus — the URL token has no form input to
      // attribute to, so the surface stays the banner pattern.
      expect(screen.getByLabelText(/e-mail/i)).not.toHaveFocus()
      expect(screen.getByLabelText(/^passwort$/i)).not.toHaveFocus()
      expect(screen.getByLabelText(/passwort bestätigen/i)).not.toHaveFocus()
    })

    it('falls back to banner copy when backend emits no fieldName', async () => {
      server.use(
        validPreviewHandler(),
        http.post('/api/auth/signup', () =>
          HttpResponse.json(
            {
              code: 'invalid_input',
              message: 'Invalid signup payload.',
              status: 400,
            },
            { status: 400 },
          ),
        ),
      )
      renderSignup()
      await fillAndSubmit()

      // A generic 400 without fieldName still renders *some* error to
      // the user via the fallback banner.
      const alert = await screen.findByRole('alert')
      expect(alert).toBeInTheDocument()
      expect(screen.queryByTestId('home')).toBeNull()
    })
  })
})
