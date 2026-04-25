import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { VersionMismatchError } from '@/features/_shared/apiError'
import {
  useCachedTranslation,
  useCreateRecipe,
  useGroupTags,
  useMarkAsCooked,
  useRecipe,
  useRecipes,
  useReimportRecipe,
  useTranslateRecipe,
} from './hooks'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('recipes hooks', () => {
  it('useRecipes returns items from the API', async () => {
    server.use(
      http.get('/api/groups/g1/recipes', () =>
        HttpResponse.json({
          items: [{ id: 'r1', title: 'R' }],
          page: 1,
          pageSize: 24,
          total: 1,
          hasNextPage: false,
          hasPrevPage: false,
        }),
      ),
    )
    const { result } = renderHook(() => useRecipes('g1'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items).toHaveLength(1)
  })

  it('useRecipe is disabled when id undefined', () => {
    const { result } = renderHook(() => useRecipe(undefined), { wrapper: makeWrapper() })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('useGroupTags returns tags', async () => {
    server.use(
      http.get('/api/groups/g1/tags', () =>
        HttpResponse.json([{ id: 't1', name: 'vegan', category: 'Diaet', isGlobal: true }]),
      ),
    )
    const { result } = renderHook(() => useGroupTags('g1'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
  })

  it('useCreateRecipe POSTs and resolves with detail', async () => {
    server.use(
      http.post('/api/groups/g1/recipes', () =>
        HttpResponse.json({ id: 'r1', title: 'Created' }, { status: 201 }),
      ),
    )
    const { result } = renderHook(() => useCreateRecipe('g1'), { wrapper: makeWrapper() })
    const detail = await result.current.mutateAsync({
      title: 'Created',
      defaultServings: 4,
      difficulty: 1,
      ingredients: [],
      steps: [],
      tagIds: [],
    })
    expect(detail.id).toBe('r1')
  })

  it('useMarkAsCooked POSTs to /cook and resolves with refreshed detail', async () => {
    server.use(
      http.post('/api/recipes/r1/cook', () =>
        HttpResponse.json({
          id: 'r1',
          groupId: 'g1',
          lastCookedAt: '2026-04-18T12:00:00Z',
        }),
      ),
    )
    const { result } = renderHook(() => useMarkAsCooked('r1'), { wrapper: makeWrapper() })
    const detail = await result.current.mutateAsync()
    expect(detail.lastCookedAt).toBe('2026-04-18T12:00:00Z')
  })
})

describe('useReimportRecipe', () => {
  it('POSTs to /api/recipes/:id/reimport and returns { importId }', async () => {
    let seenIfMatch: string | null = null
    server.use(
      http.post('/api/recipes/r1/reimport', ({ request }) => {
        seenIfMatch = request.headers.get('If-Match')
        return HttpResponse.json({ importId: 'imp-42' }, { status: 202 })
      }),
    )
    const { result } = renderHook(() => useReimportRecipe('r1'), {
      wrapper: makeWrapper(),
    })
    const response = await result.current.mutateAsync(7)
    expect(response.importId).toBe('imp-42')
    // Weak-ETag format matches the buildIfMatch helper output.
    expect(seenIfMatch).toBe('W/"r1-7"')
  })

  it('surfaces a typed VersionMismatchError on 409 with the current DTO in `current`', async () => {
    const currentDto = { id: 'r1', version: 9, title: 'Current server state' }
    server.use(
      http.post('/api/recipes/r1/reimport', () =>
        HttpResponse.json(
          {
            code: 'version_mismatch',
            message: 'Rezept wurde parallel geändert.',
            current: currentDto,
          },
          { status: 409 },
        ),
      ),
    )
    const { result } = renderHook(() => useReimportRecipe('r1'), {
      wrapper: makeWrapper(),
    })
    await expect(result.current.mutateAsync(3)).rejects.toBeInstanceOf(
      VersionMismatchError,
    )
  })

  it('surfaces photo_import_reimport_not_supported as a typed error on 400', async () => {
    server.use(
      http.post('/api/recipes/r1/reimport', () =>
        HttpResponse.json(
          {
            code: 'photo_import_reimport_not_supported',
            message:
              'Reimport ist für Foto-Imports nicht möglich — es gibt keine URL zum erneuten Abrufen.',
          },
          { status: 400 },
        ),
      ),
    )
    const { result } = renderHook(() => useReimportRecipe('r1'), {
      wrapper: makeWrapper(),
    })
    await expect(result.current.mutateAsync(0)).rejects.toMatchObject({
      code: 'photo_import_reimport_not_supported',
    })
  })

  it('surfaces source_url_missing as a typed error on 400', async () => {
    server.use(
      http.post('/api/recipes/r1/reimport', () =>
        HttpResponse.json(
          {
            code: 'source_url_missing',
            message:
              'Dieses Rezept hat keine Quell-URL — Reimport ist nur für URL-Imports möglich.',
          },
          { status: 400 },
        ),
      ),
    )
    const { result } = renderHook(() => useReimportRecipe('r1'), {
      wrapper: makeWrapper(),
    })
    await expect(result.current.mutateAsync(0)).rejects.toMatchObject({
      code: 'source_url_missing',
    })
  })

  // ── LANG-2: Translate hook ───────────────────────────────────────

  it('useTranslateRecipe POSTs to /translate with lang query and resolves', async () => {
    server.use(
      http.post('/api/recipes/r1/translate', ({ request }) => {
        const url = new URL(request.url)
        return HttpResponse.json({
          recipeId: 'r1',
          language: url.searchParams.get('lang'),
          translatedPayload: '{"title":"Translated","components":[],"tags":[]}',
          isStale: false,
          cacheHit: false,
          updatedAt: new Date().toISOString(),
        })
      }),
    )
    const { result } = renderHook(() => useTranslateRecipe('r1', 'en'), {
      wrapper: makeWrapper(),
    })
    const response = await result.current.mutateAsync()
    expect(response.language).toBe('en')
    expect(response.translatedPayload).toContain('Translated')
  })

  it('useTranslateRecipe forwards force=true on opt-in', async () => {
    let receivedForce: string | null = null
    server.use(
      http.post('/api/recipes/r1/translate', ({ request }) => {
        receivedForce = new URL(request.url).searchParams.get('force')
        return HttpResponse.json({
          recipeId: 'r1',
          language: 'en',
          translatedPayload: '{"title":"x","components":[],"tags":[]}',
          isStale: false,
          cacheHit: false,
          updatedAt: new Date().toISOString(),
        })
      }),
    )
    const { result } = renderHook(() => useTranslateRecipe('r1', 'en'), {
      wrapper: makeWrapper(),
    })
    await result.current.mutateAsync({ force: true })
    expect(receivedForce).toBe('true')
  })

  it('useTranslateRecipe surfaces already_in_language as a typed error', async () => {
    server.use(
      http.post('/api/recipes/r1/translate', () =>
        HttpResponse.json(
          {
            code: 'already_in_language',
            message:
              'Target language equals the recipe\'s source language.',
          },
          { status: 400 },
        ),
      ),
    )
    const { result } = renderHook(() => useTranslateRecipe('r1', 'de'), {
      wrapper: makeWrapper(),
    })
    await expect(result.current.mutateAsync()).rejects.toMatchObject({
      code: 'already_in_language',
    })
  })

  it('useTranslateRecipe primes the local cache; useCachedTranslation reads it back', async () => {
    server.use(
      http.post('/api/recipes/r1/translate', () =>
        HttpResponse.json({
          recipeId: 'r1',
          language: 'en',
          translatedPayload: '{"title":"Cached","components":[],"tags":[]}',
          isStale: false,
          cacheHit: false,
          updatedAt: new Date().toISOString(),
        }),
      ),
    )

    // Single QueryClient shared between both hook renderings so the
    // mutation's onSuccess primes the same cache useCachedTranslation
    // reads.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const mutation = renderHook(() => useTranslateRecipe('r1', 'en'), { wrapper })
    await mutation.result.current.mutateAsync()

    const reader = renderHook(() => useCachedTranslation('r1', 'en'), { wrapper })
    expect(reader.result.current?.translatedPayload).toContain('Cached')
  })
})
