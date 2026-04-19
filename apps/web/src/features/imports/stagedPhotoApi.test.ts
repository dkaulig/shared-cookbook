import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { ApiError } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { uploadStagedPhoto } from './stagedPhotoApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'Tester', role: 'User' },
  })
})

/**
 * P2-8 — the staged-upload helper is the only new API surface the
 * photo-import page adds. Tests cover the happy path + the two error
 * shapes the backend can emit so `ImportPhotosPage` can surface them
 * inline without generic "Upload fehlgeschlagen" messaging.
 */
describe('stagedPhotoApi.uploadStagedPhoto', () => {
  it('POSTs multipart/form-data to /api/recipes/photos/staged and returns { photoId, signedUrl, stagedPhotoId }', async () => {
    let hitMethod = ''
    let hitUrl = ''
    let sawMultipart = false
    server.use(
      http.post('/api/recipes/photos/staged', async ({ request }) => {
        hitMethod = request.method
        hitUrl = request.url
        const contentType = request.headers.get('content-type') ?? ''
        sawMultipart = contentType.startsWith('multipart/form-data')
        return HttpResponse.json(
          {
            photoId: 'recipes/abc123.jpg',
            signedUrl: '/api/photos/recipes/abc123.jpg?sig=X&exp=9999999999',
            stagedPhotoId: '11111111-2222-3333-4444-555555555555',
          },
          { status: 200 },
        )
      }),
    )

    const file = new File(['hello'], 'photo.jpg', { type: 'image/jpeg' })
    const result = await uploadStagedPhoto(file)

    expect(hitMethod).toBe('POST')
    expect(hitUrl).toMatch(/\/api\/recipes\/photos\/staged$/)
    expect(sawMultipart).toBe(true)
    expect(result.photoId).toBe('recipes/abc123.jpg')
    expect(result.signedUrl).toContain('/api/photos/recipes/abc123.jpg')
    expect(result.signedUrl).toContain('sig=')
    // PF1 — staged-photo id flows through unchanged so the importer
    // can stash it for the create-recipe promote handshake.
    expect(result.stagedPhotoId).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('throws a normalised ApiError when the backend rejects HEIC with unsupported_media_type', async () => {
    server.use(
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.json(
          {
            code: 'unsupported_media_type',
            message: 'Nur JPEG-, PNG- und WebP-Bilder sind zulässig. Bitte als JPG/PNG speichern.',
          },
          { status: 400 },
        ),
      ),
    )

    const file = new File(['heic-bytes'], 'photo.heic', { type: 'image/heic' })
    await expect(uploadStagedPhoto(file)).rejects.toMatchObject({
      code: 'unsupported_media_type',
      message: expect.stringMatching(/JPG/i),
    } satisfies Partial<ApiError>)
  })

  it('throws a normalised ApiError when the backend responds 413 for an oversize file', async () => {
    server.use(
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.json(
          { code: 'file_too_large', message: 'Das Foto überschreitet das Limit von 5 MB.' },
          { status: 413 },
        ),
      ),
    )

    const file = new File([new Uint8Array([1])], 'big.jpg', { type: 'image/jpeg' })
    await expect(uploadStagedPhoto(file)).rejects.toMatchObject({
      code: 'file_too_large',
    } satisfies Partial<ApiError>)
  })

  it('falls back to http_<status> when the error body is not JSON', async () => {
    server.use(
      http.post('/api/recipes/photos/staged', () =>
        HttpResponse.text('gateway timeout', { status: 504 }),
      ),
    )

    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' })
    await expect(uploadStagedPhoto(file)).rejects.toMatchObject({
      code: 'http_504',
    } satisfies Partial<ApiError>)
  })
})
