import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { ResetPasswordPage } from './ResetPasswordPage'
import { server } from '@/test/msw/server'

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
})
