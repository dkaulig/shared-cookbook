import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createI18n } from '@/i18n'
import { LanguageToggle } from './LanguageToggle'

/**
 * REL-3 — LanguageToggle integration test.
 *
 * Asserts the user-visible contract: click the toggle, pick EN, the
 * i18n singleton flips language and `localStorage['i18nextLng']` gets
 * updated (the detector caches the pick so a page reload keeps it).
 */

describe('LanguageToggle', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    window.localStorage.clear()
    i18n = await createI18n({ initialLng: 'de' })
  })

  it('shows DE as the current active selection by default', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageToggle />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: /sprache/i }))
    const deOption = screen.getByRole('menuitemradio', { name: /deutsch/i })
    expect(deOption).toHaveAttribute('aria-checked', 'true')
  })

  it('switches i18n language to en and persists to localStorage', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageToggle />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: /sprache/i }))
    await user.click(
      screen.getByRole('menuitemradio', { name: /english/i }),
    )
    await waitFor(() => {
      expect(i18n.language.startsWith('en')).toBe(true)
    })
    expect(window.localStorage.getItem('i18nextLng')).toBe('en')
  })

  it('menu closes on Escape', async () => {
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <LanguageToggle />
      </I18nextProvider>,
    )
    await user.click(screen.getByRole('button', { name: /sprache/i }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })
})
