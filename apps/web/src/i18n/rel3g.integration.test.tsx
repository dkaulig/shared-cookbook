import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { i18n as I18nInstance } from 'i18next'
import { createI18n } from './index'
import { CreateGroupDialog } from '@/features/groups/CreateGroupDialog'
import { RenameSessionDialog } from '@/features/chat/RenameSessionDialog'

/**
 * REL-3g — integration smoke-test.
 *
 * Verifies that the P1 call-sites migrated in this slice — settings,
 * groups dialogs, chat peripherals, admin — now flip locale when the
 * user calls `i18n.changeLanguage()`. We pick two representative
 * surfaces that live in different area namespaces so a regression in
 * any single area's JSON branch trips the assertion.
 *
 * The dialogs are rendered in isolation (they're self-contained
 * portals with no route-dependent props) so the test stays fast and
 * deterministic.
 */
function withI18n(i18n: I18nInstance, children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('i18n — REL-3g P1 call-site integration', () => {
  let i18n: I18nInstance

  beforeEach(async () => {
    i18n = await createI18n({ initialLng: 'de' })
  })

  it('CreateGroupDialog title + CTA flip to English', async () => {
    render(withI18n(i18n, <CreateGroupDialog onClose={() => {}} />))
    // German default.
    expect(
      screen.getByRole('heading', { level: 2, name: /gruppe erstellen/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^erstellen$/i }),
    ).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('en')
    })

    // English.
    expect(
      screen.getByRole('heading', { level: 2, name: /create group/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^create$/i }),
    ).toBeInTheDocument()
  })

  it('RenameSessionDialog title + helper text flip to English', async () => {
    render(
      withI18n(
        i18n,
        <RenameSessionDialog
          open={true}
          initialTitle="Test"
          onOpenChange={() => {}}
          onSubmit={() => {}}
        />,
      ),
    )
    const dialog = screen.getByRole('dialog')
    // German default.
    expect(
      within(dialog).getByText(/unterhaltung umbenennen/i),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/max\. 120 zeichen/i)).toBeInTheDocument()

    await act(async () => {
      await i18n.changeLanguage('en')
    })

    // English.
    expect(
      within(dialog).getByText(/rename conversation/i),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/max 120 characters/i),
    ).toBeInTheDocument()
  })
})
