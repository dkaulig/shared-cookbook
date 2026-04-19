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
import type { ImportStatusResponseWire } from './importsApi'
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

/**
 * PV4 — every `GET /api/imports/:id` response carries the full phase
 * snapshot + groupId. This helper builds a complete wire record so the
 * individual tests stay focused on the single field they exercise.
 */
function baseWire(
  overrides: Partial<ImportStatusResponseWire> = {},
): ImportStatusResponseWire {
  return {
    id: 'imp-x',
    groupId: 'g-x',
    source: 'Url',
    status: 'Running',
    progress: 0,
    sourceUrl: null,
    result: null,
    error: null,
    createdAt: '2026-04-18T00:00:00Z',
    completedAt: null,
    phase: 'queued',
    phaseProgress: 0,
    progressLabel: null,
    attemptNumber: 1,
    bytesDownloaded: null,
    bytesTotal: null,
    segmentsDone: null,
    segmentsTotal: null,
    lastProgressAt: '2026-04-18T00:00:00Z',
    ...overrides,
  }
}

describe('importsApi — GET /api/imports/:id', () => {
  it('normalises TitleCase status + source to lowercase', async () => {
    server.use(
      http.get('/api/imports/imp-1', () =>
        HttpResponse.json(
          baseWire({
            id: 'imp-1',
            groupId: 'g-1',
            source: 'Url',
            status: 'Running',
            progress: 42,
            sourceUrl: 'https://example.com/pizza',
            phase: 'transcribing',
            phaseProgress: 30,
          }),
        ),
      ),
    )
    const dto = await fetchImport('imp-1')
    expect(dto.source).toBe('url')
    expect(dto.status).toBe('running')
    expect(dto.progress).toBe(42)
    expect(dto.result).toBeNull()
    expect(dto.errorMessage).toBeNull()
  })

  // PV4 — `groupId` is now part of the mapped DTO. Regression guard for
  // BUG-012: the redirect on Done depends on this field surviving the
  // wire → DTO mapping.
  it('maps groupId from the wire into the normalised DTO', async () => {
    server.use(
      http.get('/api/imports/imp-groupid', () =>
        HttpResponse.json(
          baseWire({
            id: 'imp-groupid',
            groupId: 'g-42',
            status: 'Done',
            progress: 100,
            phase: 'done',
            phaseProgress: 100,
          }),
        ),
      ),
    )
    const dto = await fetchImport('imp-groupid')
    expect(dto.groupId).toBe('g-42')
  })

  // PV4 — phase-tracking snapshot round-trips through the mapper so the
  // polling fallback reaches the UI with the same information SignalR
  // would have delivered.
  it('maps all phase-tracking fields from the wire into the DTO', async () => {
    server.use(
      http.get('/api/imports/imp-phase-map', () =>
        HttpResponse.json(
          baseWire({
            id: 'imp-phase-map',
            groupId: 'g-x',
            status: 'Running',
            progress: 60,
            phase: 'transcribing',
            phaseProgress: 55,
            progressLabel: 'Audio wird transkribiert (Segment 5/10)',
            attemptNumber: 2,
            segmentsDone: 5,
            segmentsTotal: 10,
            lastProgressAt: '2026-04-18T00:00:30Z',
          }),
        ),
      ),
    )
    const dto = await fetchImport('imp-phase-map')
    expect(dto.phase).toBe('transcribing')
    expect(dto.phaseProgress).toBe(55)
    expect(dto.progressLabel).toBe('Audio wird transkribiert (Segment 5/10)')
    expect(dto.attemptNumber).toBe(2)
    expect(dto.segmentsDone).toBe(5)
    expect(dto.segmentsTotal).toBe(10)
    expect(dto.lastProgressAt).toBe('2026-04-18T00:00:30Z')
  })

  // An unknown wire phase (future-server-before-frontend or a bad proxy)
  // collapses to `'error'` so the UI shows the terminal branch instead
  // of silently drifting to an undefined phase visual.
  it('collapses an unknown phase to error', () => {
    const dto = mapStatusResponse(
      baseWire({ id: 'imp-x', phase: 'something_new' }),
    )
    expect(dto.phase).toBe('error')
  })

  it('parses the JSON result string into ExtractionResult when status=Done', async () => {
    server.use(
      http.get('/api/imports/imp-2', () =>
        HttpResponse.json(
          baseWire({
            id: 'imp-2',
            groupId: 'g-2',
            status: 'Done',
            progress: 100,
            sourceUrl: 'https://example.com/pizza',
            result: JSON.stringify(sampleResult),
            completedAt: '2026-04-18T00:01:00Z',
            phase: 'done',
            phaseProgress: 100,
          }),
        ),
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
        HttpResponse.json(
          baseWire({
            id: 'imp-3',
            groupId: 'g-3',
            status: 'Error',
            progress: 30,
            sourceUrl: 'https://private.example/private',
            error: 'Video ist privat oder nicht verfügbar.',
            completedAt: '2026-04-18T00:00:30Z',
            phase: 'error',
          }),
        ),
      ),
    )
    const dto = await fetchImport('imp-3')
    expect(dto.status).toBe('error')
    expect(dto.errorMessage).toMatch(/privat/i)
  })

  it('returns null result when the backend sent malformed JSON in result', () => {
    const dto = mapStatusResponse(
      baseWire({
        id: 'imp-4',
        groupId: 'g-4',
        status: 'Done',
        progress: 100,
        sourceUrl: 'https://example.com/x',
        result: '{not json',
        completedAt: '2026-04-18T00:00:00Z',
        phase: 'done',
        phaseProgress: 100,
      }),
    )
    expect(dto.status).toBe('done')
    expect(dto.result).toBeNull()
  })

  it('falls through to error when the status string is unknown', () => {
    const dto = mapStatusResponse(
      baseWire({
        id: 'imp-5',
        groupId: 'g-5',
        status: 'Nonsense',
      }),
    )
    expect(dto.status).toBe('error')
  })
})
