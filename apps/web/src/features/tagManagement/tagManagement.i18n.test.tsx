import { describe, expect, it, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, act } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { createI18n } from '@/i18n/index'
import { GroupTagsPanel } from './GroupTagsPanel'
import { CreateTagDialog } from './CreateTagDialog'

/**
 * SMALL-1a — smoke-tests the EN-locale rendering for tag-management
 * surfaces. Mirrors the REL-3b integration pattern: detached i18n
 * instance, flip language to `en`, assert localised copy reaches the
 * rendered DOM. Catches breakage if the EN-locale JSON drifts from
 * the translation keys consumed in components.
 */

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function withI18n(i18n: I18nInstance, children: ReactNode) {
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

describe('tagManagement i18n — EN locale smoke', () => {
  it('GroupTagsPanel renders English copy after language flip', async () => {
    server.use(
      http.get('/api/groups/g1', () =>
        HttpResponse.json({
          id: 'g1',
          name: 'Family',
          description: null,
          coverImageUrl: null,
          defaultServings: 4,
          isPrivateCollection: false,
          myRole: 'Admin',
          members: [
            {
              userId: 'u1',
              displayName: 'U',
              role: 'Admin',
              joinedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      ),
      http.get('/api/groups/g1/tags', () =>
        HttpResponse.json([
          {
            id: 't-global',
            name: 'fast',
            category: 'Aufwand',
            isGlobal: true,
            groupId: null,
            createdByUserId: null,
          },
        ]),
      ),
    )
    const i18n = await createI18n({ initialLng: 'de' })
    render(withI18n(i18n, <GroupTagsPanel groupId="g1" />))

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /Eigene Tags/i, level: 3 }),
      ).toBeInTheDocument(),
    )

    await act(async () => {
      await i18n.changeLanguage('en')
    })

    expect(
      screen.getByRole('heading', { name: /Custom tags/i, level: 3 }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /Global tags/i, level: 3 }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Global, not deletable/i)).toBeInTheDocument()
  })

  it('CreateTagDialog renders English copy after language flip', async () => {
    const i18n = await createI18n({ initialLng: 'en' })
    render(withI18n(i18n, <CreateTagDialog groupId="g1" onClose={() => {}} />))
    expect(
      screen.getByRole('heading', { name: /Create custom tag/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Create tag$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument()
  })
})
