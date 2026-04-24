import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { i18n as I18nInstance } from 'i18next'
import { createI18n } from './index'
import { LoginPage } from '@/features/auth/LoginPage'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { PortionStepperCard } from '@/features/recipes/PortionStepperCard'
import { useAuthStore } from '@/features/auth/authStore'

/**
 * REL-3b — integration smoke-test.
 *
 * Verifies that the P0 call-sites — now consuming their copy through
 * `t()` — re-render with English copy when the user flips the language
 * via `i18n.changeLanguage()`. Exercises three surfaces that live in
 * different areas (auth page, recipes presentational component) so a
 * regression in one area-specific locale JSON branch would fail the
 * assertion immediately.
 *
 * We render through `I18nextProvider` with an isolated `createI18n()`
 * instance so the tests don't leak state (the detached instance is
 * different from the default singleton the rest of the app uses).
 */

function withI18n(i18n: I18nInstance, children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route element={<AuthLayout />}>
              <Route path="/login" element={children as JSX.Element} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('i18n — REL-3b P0 call-site integration', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    window.localStorage.clear()
    useAuthStore.getState().clear()
    i18n = await createI18n({ initialLng: 'de' })
  })

  it('LoginPage hero + CTA flip to English on language change', async () => {
    render(withI18n(i18n, <LoginPage />))
    // German default.
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/was kochen wir heute/i)
    expect(
      screen.getByRole('button', { name: /^anmelden$/i }),
    ).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('en')
    })

    // English — hero + primary CTA.
    expect(
      screen.getByRole('heading', { level: 1 }).textContent,
    ).toMatch(/what are we cooking today/i)
    expect(
      screen.getByRole('button', { name: /^sign in$/i }),
    ).toBeInTheDocument()
  })

  it('PortionStepperCard group-default CTA flips to English', async () => {
    function Wrapped() {
      return (
        <PortionStepperCard
          servings={2}
          onServingsChange={() => {}}
          groupDefaultServings={4}
          groupName="Familie"
        />
      )
    }
    render(
      <I18nextProvider i18n={i18n}>
        <Wrapped />
      </I18nextProvider>,
    )
    expect(screen.getByText(/für familie umrechnen/i)).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('en')
    })

    expect(screen.getByText(/scale for familie/i)).toBeInTheDocument()
  })
})
