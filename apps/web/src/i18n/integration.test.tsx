import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import type { i18n as I18nInstance } from 'i18next'
import { createI18n } from './index'
import { NotFoundPage } from '@/components/NotFoundPage'
import {
  ErrorBanner,
  classifyMutationError,
} from '@/features/_shared/errorSurface'

/**
 * REL-3 — integration smoke-test.
 *
 * Verifies that the extracted P0 surfaces re-render with the new locale
 * when the user flips the language via `i18n.changeLanguage()`. Covers
 * NotFoundPage (nav-level copy), ErrorBanner (primitive), and the
 * classifier's code-table lookup for backend error-codes.
 */

function withI18n(i18n: I18nInstance, children: React.ReactNode) {
  return (
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>{children}</MemoryRouter>
    </I18nextProvider>
  )
}

describe('i18n — P0 surface integration', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    window.localStorage.clear()
    i18n = await createI18n({ initialLng: 'de' })
  })

  it('NotFoundPage flips to English on language change', async () => {
    render(withI18n(i18n, <NotFoundPage />))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /hier kocht niemand/i,
    )
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /nobody/i,
    )
  })

  it('ErrorBanner close-button aria-label follows active locale', async () => {
    render(
      withI18n(
        i18n,
        <ErrorBanner message="boom" onDismiss={() => {}} />,
      ),
    )
    expect(
      screen.getByRole('button', { name: /schließen/i }),
    ).toBeInTheDocument()
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(
      screen.getByRole('button', { name: /close/i }),
    ).toBeInTheDocument()
  })

  it('classifyMutationError routes error-codes through the errors namespace', async () => {
    // The classifier reads from the default singleton; bootstrap it
    // here so the assertion actually exercises the errors-namespace
    // lookup (instead of the pre-init defaultValue fallback).
    const defaultI18n = (await import('./index')).default
    if (!defaultI18n.isInitialized) {
      await createI18n() // initialises the singleton (no initialLng).
    }
    await act(async () => {
      await defaultI18n.changeLanguage('de')
    })
    const result = classifyMutationError({
      code: 'invalid_value',
      message: 'backend message ignored when code maps',
      status: 400,
    })
    expect(result.surface).toBe('inline')
    expect(result.message).toBe('Ungültiger Wert.')
    expect(result.code).toBe('invalid_value')

    await act(async () => {
      await defaultI18n.changeLanguage('en')
    })
    const resultEn = classifyMutationError({
      code: 'invalid_value',
      message: 'backend message ignored when code maps',
      status: 400,
    })
    expect(resultEn.message).toBe('Invalid value.')
  })
})
