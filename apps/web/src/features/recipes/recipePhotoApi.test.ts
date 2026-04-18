import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { ApiError } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { uploadRecipePhoto } from './recipePhotoApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'Tester', role: 'User' },
  })
})

/**
 * UX1-PU — low-level photo-upload helper that both the edit-mode hook
 * and the create-mode form submit share. The helper owns the multipart
 * plumbing; callers just pass a recipeId + File.
 */
describe('recipePhotoApi.uploadRecipePhoto', () => {
  it('POSTs multipart/form-data to /api/recipes/{id}/photos and returns the url', async () => {
    let hitMethod = ''
    let hitUrl = ''
    let sawFilePart = false
    server.use(
      http.post('/api/recipes/r1/photos', async ({ request }) => {
        hitMethod = request.method
        hitUrl = request.url
        const form = await request.formData()
        sawFilePart = form.get('file') instanceof File
        return HttpResponse.json({ url: 'fake://new.jpg' }, { status: 201 })
      }),
    )

    const file = new File([new Uint8Array([1, 2, 3])], 'p.jpg', { type: 'image/jpeg' })
    const result = await uploadRecipePhoto('r1', file)

    expect(hitMethod).toBe('POST')
    expect(hitUrl).toMatch(/\/api\/recipes\/r1\/photos$/)
    expect(sawFilePart).toBe(true)
    expect(result.url).toBe('fake://new.jpg')
  })

  it('throws a normalised ApiError when the backend responds with 413 (payload too large)', async () => {
    server.use(
      http.post('/api/recipes/r1/photos', () =>
        HttpResponse.json(
          { code: 'photo_too_large', message: 'Bild darf maximal 5 MB groß sein.' },
          { status: 413 },
        ),
      ),
    )

    const file = new File([new Uint8Array([1])], 'big.jpg', { type: 'image/jpeg' })
    await expect(uploadRecipePhoto('r1', file)).rejects.toMatchObject({
      code: 'photo_too_large',
      message: expect.stringMatching(/5 MB/i),
    } satisfies Partial<ApiError>)
  })

  it('throws a normalised ApiError when the backend responds with 5xx', async () => {
    server.use(
      http.post('/api/recipes/r1/photos', () =>
        HttpResponse.json(
          { code: 'storage_unavailable', message: 'Speicher nicht erreichbar.' },
          { status: 503 },
        ),
      ),
    )

    const file = new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' })
    await expect(uploadRecipePhoto('r1', file)).rejects.toMatchObject({
      code: 'storage_unavailable',
    } satisfies Partial<ApiError>)
  })
})
