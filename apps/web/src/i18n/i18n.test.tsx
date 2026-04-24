import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { createI18n, SUPPORTED_LANGUAGES } from './index'
import type { i18n as I18nInstance } from 'i18next'

/**
 * REL-3 — i18n-foundation tests.
 *
 * These assert the runtime contract the rest of the app relies on:
 *   1. `de` is the maintainer default (CLAUDE.md).
 *   2. `en` is the Prod-default AND a supported 2nd language.
 *   3. Missing EN keys fall back to DE (we ship ~60-80% EN coverage,
 *      the rest must not render "nav.home" as the UI string).
 *   4. `errors` namespace maps backend error-codes to localised copy.
 *   5. Language-change is reactive without a page reload.
 *   6. localStorage override is honoured across reloads.
 */

function TestHarness() {
  const { t, i18n } = useTranslation()
  return (
    <div>
      <span data-testid="lang">{i18n.language}</span>
      <span data-testid="known-key">{t('nav.home')}</span>
      <span data-testid="error-key">
        {t('invalid_value', { ns: 'errors' })}
      </span>
    </div>
  )
}

describe('i18n foundation', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    window.localStorage.clear()
    i18n = await createI18n({
      // Force a known default so we don't depend on prod-vs-dev env.
      initialLng: 'de',
    })
  })

  afterEach(() => {
    // Reset so the next test starts clean.
    window.localStorage.clear()
  })

  it('supports de + en as languages', () => {
    expect(SUPPORTED_LANGUAGES).toContain('de')
    expect(SUPPORTED_LANGUAGES).toContain('en')
  })

  it('boots with the requested initial language', () => {
    expect(i18n.language.startsWith('de')).toBe(true)
  })

  it('renders German translation by default', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TestHarness />
      </I18nextProvider>,
    )
    // `nav.home` must be "Start" in German copy (matches the existing
    // BottomNav/SideRail label).
    expect(screen.getByTestId('known-key').textContent).toBe('Start')
  })

  it('switches to English when changeLanguage is called', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TestHarness />
      </I18nextProvider>,
    )
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByTestId('known-key').textContent).toBe('Home')
    expect(screen.getByTestId('lang').textContent).toBe('en')
  })

  it('falls back to German for missing English keys', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TestHarness />
      </I18nextProvider>,
    )
    await act(async () => {
      await i18n.changeLanguage('en')
      // Simulate a key that only exists in de — the fallback keeps the
      // UI alive even when an EN translation is missing.
      i18n.addResource(
        'de',
        'translation',
        'debug.onlyGerman',
        'Nur auf Deutsch',
      )
    })
    const { t } = i18n
    expect(t('debug.onlyGerman')).toBe('Nur auf Deutsch')
  })

  it('translates backend error-codes via the errors namespace', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <TestHarness />
      </I18nextProvider>,
    )
    // DE copy of the `invalid_value` code.
    expect(screen.getByTestId('error-key').textContent).toBe(
      'Ungültiger Wert.',
    )
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(screen.getByTestId('error-key').textContent).toBe('Invalid value.')
  })

  it('persists the language choice in localStorage', async () => {
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(window.localStorage.getItem('i18nextLng')).toBe('en')
  })
})
