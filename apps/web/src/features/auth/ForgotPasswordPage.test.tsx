import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'
import { ForgotPasswordPage } from './ForgotPasswordPage'
import { server } from '@/test/msw/server'

function renderForgot() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <Routes>
        <Route element={<AuthLayout />}>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<div data-testid="login">Anmelden</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('<ForgotPasswordPage />', () => {
  afterEach(() => {
    server.resetHandlers()
  })

  it('renders the hero headline, card title, and button copy from the spec', () => {
    renderForgot()
    expect(
      screen.getByRole('heading', { level: 1, name: /passwort zurücksetzen/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: /passwort zurücksetzen/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/wir senden dir eine e-mail mit link/i),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /link anfordern/i })).toBeInTheDocument()
  })

  it('links back to /login for returning users', () => {
    renderForgot()
    expect(screen.getByRole('link', { name: /zurück zur anmeldung/i })).toHaveAttribute(
      'href',
      '/login',
    )
  })

  it('shows a German error when the email format is invalid', async () => {
    const user = userEvent.setup()
    renderForgot()

    await user.type(screen.getByLabelText(/e-mail/i), 'not-an-email')
    await user.click(screen.getByRole('button', { name: /link anfordern/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/gültige e-mail/i)
  })

  it('shows the always-success note and never leaks enumeration', async () => {
    server.use(
      http.post('/api/auth/password-reset-request', () => new HttpResponse(null, { status: 204 })),
    )

    const user = userEvent.setup()
    renderForgot()

    await user.type(screen.getByLabelText(/e-mail/i), 'maybe@example.com')
    await user.click(screen.getByRole('button', { name: /link anfordern/i }))

    expect(
      await screen.findByText(/wenn diese e-mail existiert/i),
    ).toBeInTheDocument()
  })
})
