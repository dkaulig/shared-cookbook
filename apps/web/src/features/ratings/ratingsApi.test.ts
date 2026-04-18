import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RatingListResponse, UpsertRatingResponse } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { deleteRating, fetchRatings, upsertRating } from './ratingsApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('ratingsApi', () => {
  it('fetchRatings issues GET against the ratings endpoint', async () => {
    let url = ''
    server.use(
      http.get('/api/recipes/r1/ratings', ({ request }) => {
        url = request.url
        return HttpResponse.json<RatingListResponse>({
          aggregate: { avg: 4.5, count: 2, myStars: 4, myComment: 'gut' },
          ratings: [],
        })
      }),
    )
    const result = await fetchRatings('r1')
    expect(url).toContain('/api/recipes/r1/ratings')
    expect(result.aggregate.avg).toBe(4.5)
  })

  it('upsertRating POSTs body', async () => {
    let bodyText: unknown = null
    server.use(
      http.post('/api/recipes/r1/ratings', async ({ request }) => {
        bodyText = await request.json()
        return HttpResponse.json<UpsertRatingResponse>({
          aggregate: { avg: 5, count: 1, myStars: 5, myComment: null },
          rating: {
            userId: 'u1',
            displayName: 'U',
            stars: 5,
            comment: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      }),
    )

    const result = await upsertRating('r1', { stars: 5 })
    expect(bodyText).toEqual({ stars: 5 })
    expect(result.rating.stars).toBe(5)
  })

  it('deleteRating issues DELETE', async () => {
    let called = false
    server.use(
      http.delete('/api/recipes/r1/ratings', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await deleteRating('r1')
    expect(called).toBe(true)
  })

  it('upsertRating throws ApiError on 400', async () => {
    server.use(
      http.post('/api/recipes/r1/ratings', () =>
        HttpResponse.json({ code: 'invalid_input', message: 'falsch' }, { status: 400 }),
      ),
    )
    await expect(upsertRating('r1', { stars: 6 })).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})
