import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { HomePage } from '@/features/home/HomePage'
import { ImportPhotosPage } from '@/features/imports/ImportPhotosPage'
import { ChatRouteOutlet } from '@/features/chat/ChatRouteOutlet'

/**
 * REL-7 — cross-page integration tests for the "AI off" UX.
 *
 * Exercises the contract documented in the design doc's REL-7 section:
 * when `/api/meta/features` reports `ai.enabled = false`, Home's
 * KI-Import CTA row must collapse, ImportPhotosPage must show an
 * AI-disabled notice, and the Chat subtree must short-circuit to the
 * same notice before fetching any chat data.
 *
 * Keeps the MSW overrides hermetic — each test calls `server.use(...)`
 * to flip the features response before rendering.
 */

const AI_OFF_RESPONSE = {
  ai: {
    enabled: false,
    provider: null,
    features: {
      urlImport: false,
      jsonldImport: true,
      videoImport: false,
      photoImport: false,
      chat: false,
    },
  },
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
  return { Wrapper }
}

describe('REL-7 AI off integration', () => {
  beforeEach(() => {
    // Home + ImportPhotosPage need an authenticated session for their
    // group / import hooks to run. Mint a minimal user so those hooks
    // don't short-circuit on anonymous state.
    useAuthStore.setState({
      isAuthenticated: true,
      accessToken: 'test',
      user: {
        id: 'u1',
        email: 'user@example.com',
        displayName: 'Nutzer',
        role: 'User',
      },
    })
    server.use(
      http.get('/api/meta/features', () => HttpResponse.json(AI_OFF_RESPONSE)),
      // The Home + ImportPhotos hooks touch these; respond with
      // empty-but-valid shapes so the page renders without unrelated
      // errors that would obscure the gate assertions.
      http.get('/api/groups/mine', () => HttpResponse.json([])),
      http.get('/api/recipes/recently-cooked', () =>
        HttpResponse.json({ items: [] }),
      ),
    )
  })

  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('HomePage hides the KI-Import CTA row when AI is off', async () => {
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <HomePage />
      </Wrapper>,
    )
    // The greeting always renders; wait for it so we know the page
    // mounted before asserting the absence of the CTA row.
    await waitFor(() =>
      expect(screen.getByText(/Was kochen wir heute/i)).toBeInTheDocument(),
    )
    // CTA row container has a stable testid; it should never appear.
    await waitFor(() =>
      expect(screen.queryByTestId('home-ai-imports')).not.toBeInTheDocument(),
    )
    // Sanity: none of the three links render either.
    expect(screen.queryByText(/Rezept aus Video importieren/i)).toBeNull()
    expect(screen.queryByText(/Rezept aus Foto importieren/i)).toBeNull()
    expect(screen.queryByText(/Rezept im Chat erfinden/i)).toBeNull()
  })

  it('ImportPhotosPage shows AiDisabledNotice when photoImport is off', async () => {
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <ImportPhotosPage />
      </Wrapper>,
    )
    await waitFor(() =>
      expect(screen.getByText(/Foto-Import benötigt KI/i)).toBeInTheDocument(),
    )
    // The real form (hidden file inputs etc.) never mounts.
    expect(screen.queryByTestId('photos-gallery-input')).toBeNull()
  })

  it('ChatRouteOutlet short-circuits to AiDisabledNotice when chat is off', async () => {
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <ChatRouteOutlet />
      </Wrapper>,
    )
    await waitFor(() =>
      expect(screen.getByText(/Rezept-Chat benötigt KI/i)).toBeInTheDocument(),
    )
  })
})
