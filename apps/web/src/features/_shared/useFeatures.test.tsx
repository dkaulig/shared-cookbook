import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFeatures } from './useFeatures'
import { FeatureGate } from './FeatureGate'
import { server } from '@/test/msw/server'

/**
 * REL-7 — unit tests for the AI-feature-gate primitives.
 *
 * Covers three axes:
 *   - useFeatures() shape + fallback when the endpoint fails.
 *   - <FeatureGate feature="..."> renders + hides correctly per flag.
 *   - "AI off" response collapses the gated surface to null.
 */

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
      },
    },
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return { client, Wrapper }
}

describe('useFeatures', () => {
  afterEach(() => {
    server.resetHandlers()
  })

  it('returns the AI-on defaults from the default handler', async () => {
    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useFeatures(), { wrapper: Wrapper })
    // Wait for provider to flip from the optimistic placeholder `null`
    // to the handler's `azure` — once that's set, the fetch has settled.
    await waitFor(() => expect(result.current.ai.provider).toBe('azure'))
    expect(result.current.ai.enabled).toBe(true)
    expect(result.current.ai.features.chat).toBe(true)
    expect(result.current.ai.features.photoImport).toBe(true)
  })

  it('reflects an AI-off response', async () => {
    server.use(
      http.get('/api/meta/features', () =>
        HttpResponse.json({
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
        }),
      ),
    )
    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useFeatures(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.ai.enabled).toBe(false))
    expect(result.current.ai.provider).toBeNull()
    expect(result.current.ai.features.chat).toBe(false)
    expect(result.current.ai.features.photoImport).toBe(false)
    // JSON-LD stays on — REL-8 works without AI.
    expect(result.current.ai.features.jsonldImport).toBe(true)
  })

  it('falls back to AI-off defaults when the endpoint fails', async () => {
    server.use(
      http.get('/api/meta/features', () => new HttpResponse(null, { status: 500 })),
    )
    const { Wrapper } = makeWrapper()
    const { result } = renderHook(() => useFeatures(), { wrapper: Wrapper })
    // Optimistic AI-on while the query is in-flight; once the fetch
    // fails (+ the single retry also fails) we flip to AI_OFF_FALLBACK.
    // Bigger timeout because TanStack Query waits up to ~1s between
    // the initial failure and the retry attempt.
    await waitFor(() => expect(result.current.ai.enabled).toBe(false), {
      timeout: 5000,
    })
    expect(result.current.ai.features.chat).toBe(false)
    expect(result.current.ai.features.jsonldImport).toBe(true)
  })
})

describe('<FeatureGate>', () => {
  afterEach(() => {
    server.resetHandlers()
  })

  it('renders children when the feature is enabled', async () => {
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <FeatureGate feature="chat">
          <span data-testid="chat-cta">Chat</span>
        </FeatureGate>
      </Wrapper>,
    )
    await waitFor(() => expect(screen.getByTestId('chat-cta')).toBeInTheDocument())
  })

  it('hides children when the feature is disabled', async () => {
    server.use(
      http.get('/api/meta/features', () =>
        HttpResponse.json({
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
        }),
      ),
    )
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <FeatureGate feature="chat">
          <span data-testid="chat-cta">Chat</span>
        </FeatureGate>
      </Wrapper>,
    )
    // placeholderData = AI-off → child never appears.
    await waitFor(() => {
      expect(screen.queryByTestId('chat-cta')).not.toBeInTheDocument()
    })
  })

  it('renders a fallback when the feature is disabled', async () => {
    server.use(
      http.get('/api/meta/features', () =>
        HttpResponse.json({
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
        }),
      ),
    )
    const { Wrapper } = makeWrapper()
    render(
      <Wrapper>
        <FeatureGate
          feature="photoImport"
          fallback={<span data-testid="fallback">Foto-Import ohne KI</span>}
        >
          <span data-testid="photo-cta">Foto-Import</span>
        </FeatureGate>
      </Wrapper>,
    )
    await waitFor(() => expect(screen.getByTestId('fallback')).toBeInTheDocument())
    expect(screen.queryByTestId('photo-cta')).not.toBeInTheDocument()
  })
})
