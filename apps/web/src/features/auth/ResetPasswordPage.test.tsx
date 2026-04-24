import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { ResetPasswordPage } from './ResetPasswordPage'
import { server } from '@/test/msw/server'
import { createI18n } from '@/i18n'

function renderReset(search: string = '?token=reset-token') {
  return render(
    <MemoryRouter initialEntries={[`/reset-password${search}`]}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<div data-testid="login">Anmelden</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('<ResetPasswordPage />', () => {
  // REL-5f — init the shared i18n singleton so `classifyMutationError`
  // resolves `errors:<code>` keys to German copy. REL-5f tests assert
  // the translated string lands in the fallback banner for `resetToken`
  // (no form-input to focus — token lives in the URL).
  beforeAll(async () => {
    window.localStorage.setItem('i18nextLng', 'de')
    await createI18n()
  })

  afterEach(() => {
    server.resetHandlers()
  })

  it('renders the hero headline, card title, and Speichern button', () => {
    renderReset()
    expect(
      screen.getByRole('heading', { level: 1, name: /neues passwort wählen/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: /neues passwort wählen/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^speichern$/i })).toBeInTheDocument()
  })

  it('shows a German error when the password is too short', async () => {
    const user = userEvent.setup()
    renderReset()

    await user.type(screen.getByLabelText(/^neues passwort$/i), 'kurz')
    await user.type(screen.getByLabelText(/passwort bestätigen/i), 'kurz')
    await user.click(screen.getByRole('button', { name: /^speichern$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/mindestens 8 zeichen/i)
  })

  it('shows a German error when confirmation does not match', async () => {
    const user = userEvent.setup()
    renderReset()

    await user.type(screen.getByLabelText(/^neues passwort$/i), 'geheim123')
    await user.type(screen.getByLabelText(/passwort bestätigen/i), 'anders123')
    await user.click(screen.getByRole('button', { name: /^speichern$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/stimmen nicht überein/i)
  })

  it('on 200 surfaces the success note and redirects to /login', async () => {
    server.use(
      http.post('/api/auth/password-reset', () => new HttpResponse(null, { status: 204 })),
    )

    const user = userEvent.setup()
    renderReset()

    await user.type(screen.getByLabelText(/^neues passwort$/i), 'geheim123')
    await user.type(screen.getByLabelText(/passwort bestätigen/i), 'geheim123')
    await user.click(screen.getByRole('button', { name: /^speichern$/i }))

    expect(await screen.findByText(/passwort geändert/i)).toBeInTheDocument()
    await waitFor(
      () => {
        expect(screen.getByTestId('login')).toBeInTheDocument()
      },
      { timeout: 2500 },
    )
  })

  // ── REL-5f inline field-focus ───────────────────────────────────
  describe('REL-5f inline field-focus', () => {
    async function fillAndSubmit() {
      const user = userEvent.setup()
      await user.type(screen.getByLabelText(/^neues passwort$/i), 'geheim123')
      await user.type(screen.getByLabelText(/passwort bestätigen/i), 'geheim123')
      await user.click(screen.getByRole('button', { name: /^speichern$/i }))
      return user
    }

    it('surfaces a translated banner when backend tags fieldName=resetToken (no input to focus — token is in URL)', async () => {
      server.use(
        http.post('/api/auth/password-reset', () =>
          HttpResponse.json(
            {
              code: 'invalid_token',
              message: 'Invalid reset link.',
              status: 400,
              fieldName: 'resetToken',
            },
            { status: 400 },
          ),
        ),
      )
      renderReset()
      await fillAndSubmit()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/token ist ungültig/i)
      // English wire copy never reaches the user.
      expect(screen.queryByText(/invalid reset link/i)).toBeNull()
      // Password inputs kept their focus state — nothing to attribute to.
      expect(screen.getByLabelText(/^neues passwort$/i)).not.toHaveFocus()
      expect(screen.getByLabelText(/passwort bestätigen/i)).not.toHaveFocus()
    })

    it('renders translated reset_failed copy when Identity rejects the reset', async () => {
      server.use(
        http.post('/api/auth/password-reset', () =>
          HttpResponse.json(
            {
              code: 'reset_failed',
              message:
                'Password reset failed. The link may be expired or the password rejected.',
              status: 400,
              fieldName: 'resetToken',
            },
            { status: 400 },
          ),
        ),
      )
      renderReset()
      await fillAndSubmit()

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/zurücksetzen fehlgeschlagen/i)
      expect(screen.queryByText(/link may be expired/i)).toBeNull()
    })
  })
})
