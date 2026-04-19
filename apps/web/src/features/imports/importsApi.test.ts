import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  enqueuePhotoImport,
  enqueueUrlImport,
  fetchImport,
  mapStatusResponse,
} from './importsApi'
import type { ExtractionResult } from '@familien-kochbuch/shared'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

const sampleResult: ExtractionResult = {
  recipe: {
    title: 'Pizza Margherita',
    description: null,
    servings: 4,
    difficulty: null,
    prep_minutes: null,
    cook_minutes: null,
    ingredients: [],
    steps: [],
    tags: [],
    source_url: 'https://example.com/pizza',
    thumbnail_url: null,
  },
  confidence: { overall: 'high', notes: [] },
}

describe('importsApi — POST /api/recipes/import/url', () => {
  it('returns the importId on success', async () => {
    server.use(
      http.post('/api/recipes/import/url', async ({ request }) => {
        const body = (await request.json()) as { url: string; groupId: string }
        expect(body.url).toBe('https://example.com/pizza')
        expect(body.groupId).toBe('g1')
        return HttpResponse.json({ importId: 'imp-123' }, { status: 202 })
      }),
    )
    const res = await enqueueUrlImport({
      url: 'https://example.com/pizza',
      groupId: 'g1',
    })
    expect(res.importId).toBe('imp-123')
  })

  it('throws an ApiError on 400', async () => {
    server.use(
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          {
            code: 'invalid_url',
            message:
              'Die URL muss absolut sein und mit http:// oder https:// beginnen.',
          },
          { status: 400 },
        ),
      ),
    )
    await expect(
      enqueueUrlImport({ url: 'notaurl', groupId: 'g1' }),
    ).rejects.toThrow(/Die URL muss absolut sein/)
  })
})

describe('importsApi — POST /api/recipes/import/photos', () => {
  it('posts the signed photo URL array + groupId and returns the importId', async () => {
    let capturedBody: { photoUrls: string[]; groupId: string } | null = null
    server.use(
      http.post('/api/recipes/import/photos', async ({ request }) => {
        capturedBody = (await request.json()) as {
          photoUrls: string[]
          groupId: string
        }
        return HttpResponse.json({ importId: 'imp-photos-1' }, { status: 202 })
      }),
    )
    const res = await enqueuePhotoImport({
      photoUrls: [
        '/api/photos/recipes/a.jpg?sig=1&exp=9',
        '/api/photos/recipes/b.jpg?sig=2&exp=9',
      ],
      groupId: 'g1',
    })
    expect(res.importId).toBe('imp-photos-1')
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!.groupId).toBe('g1')
    expect(capturedBody!.photoUrls).toHaveLength(2)
  })

  it('throws an ApiError on 400 invalid_photo_url', async () => {
    server.use(
      http.post('/api/recipes/import/photos', () =>
        HttpResponse.json(
          {
            code: 'invalid_photo_url',
            message:
              'Mindestens ein Foto wurde nicht über die offizielle Upload-Route bereitgestellt.',
          },
          { status: 400 },
        ),
      ),
    )
    await expect(
      enqueuePhotoImport({ photoUrls: ['nope'], groupId: 'g1' }),
    ).rejects.toThrow(/offizielle Upload-Route/)
  })
})

describe('importsApi — GET /api/imports/:id', () => {
  it('normalises TitleCase status + source to lowercase', async () => {
    server.use(
      http.get('/api/imports/imp-1', () =>
        HttpResponse.json({
          id: 'imp-1',
          source: 'Url',
          status: 'Running',
          progress: 42,
          sourceUrl: 'https://example.com/pizza',
          result: null,
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: null,
        }),
      ),
    )
    const dto = await fetchImport('imp-1')
    expect(dto.source).toBe('url')
    expect(dto.status).toBe('running')
    expect(dto.progress).toBe(42)
    expect(dto.result).toBeNull()
    expect(dto.errorMessage).toBeNull()
  })

  it('parses the JSON result string into ExtractionResult when status=Done', async () => {
    server.use(
      http.get('/api/imports/imp-2', () =>
        HttpResponse.json({
          id: 'imp-2',
          source: 'Url',
          status: 'Done',
          progress: 100,
          sourceUrl: 'https://example.com/pizza',
          result: JSON.stringify(sampleResult),
          error: null,
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:01:00Z',
        }),
      ),
    )
    const dto = await fetchImport('imp-2')
    expect(dto.status).toBe('done')
    expect(dto.result?.recipe.title).toBe('Pizza Margherita')
    expect(dto.result?.confidence.overall).toBe('high')
  })

  it('surfaces the backend error message when status=Error', async () => {
    server.use(
      http.get('/api/imports/imp-3', () =>
        HttpResponse.json({
          id: 'imp-3',
          source: 'Url',
          status: 'Error',
          progress: 30,
          sourceUrl: 'https://private.example/private',
          result: null,
          error: 'Video ist privat oder nicht verfügbar.',
          createdAt: '2026-04-18T00:00:00Z',
          completedAt: '2026-04-18T00:00:30Z',
        }),
      ),
    )
    const dto = await fetchImport('imp-3')
    expect(dto.status).toBe('error')
    expect(dto.errorMessage).toMatch(/privat/i)
  })

  it('returns null result when the backend sent malformed JSON in result', () => {
    const dto = mapStatusResponse({
      id: 'imp-4',
      source: 'Url',
      status: 'Done',
      progress: 100,
      sourceUrl: 'https://example.com/x',
      result: '{not json',
      error: null,
      createdAt: '2026-04-18T00:00:00Z',
      completedAt: '2026-04-18T00:00:00Z',
    })
    expect(dto.status).toBe('done')
    expect(dto.result).toBeNull()
  })

  it('falls through to error when the status string is unknown', () => {
    const dto = mapStatusResponse({
      id: 'imp-5',
      source: 'Url',
      status: 'Nonsense',
      progress: 0,
      sourceUrl: null,
      result: null,
      error: null,
      createdAt: '2026-04-18T00:00:00Z',
      completedAt: null,
    })
    expect(dto.status).toBe('error')
  })
})
