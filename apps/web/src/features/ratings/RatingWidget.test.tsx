import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RatingListResponse, UpsertRatingResponse } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RatingWidget } from './RatingWidget'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function renderWidget(recipeId = 'r1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<RatingWidget recipeId={recipeId} />, { wrapper })
}

function mockRatings(payload: RatingListResponse) {
  server.use(
    http.get('/api/recipes/r1/ratings', () => HttpResponse.json(payload)),
  )
}

describe('RatingWidget', () => {
  it('shows empty aggregate when nobody has rated yet', async () => {
    mockRatings({ aggregate: { avg: null, count: 0, myStars: null, myComment: null }, ratings: [] })

    renderWidget()

    await waitFor(() =>
      expect(screen.getByText(/Noch keine Bewertung/i)).toBeInTheDocument(),
    )
  })

  it('shows aggregate and pre-fills star/comment state when current user has rated', async () => {
    mockRatings({
      aggregate: { avg: 4.5, count: 2, myStars: 4, myComment: 'mein Kommentar' },
      ratings: [
        {
          userId: 'u1',
          displayName: 'U',
          stars: 4,
          comment: 'mein Kommentar',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })

    renderWidget()
    await waitFor(() => expect(screen.getByText(/4,5/)).toBeInTheDocument())

    const textarea = screen.getByLabelText(/Kommentar/i) as HTMLTextAreaElement
    expect(textarea.value).toBe('mein Kommentar')

    const starButton = screen.getByRole('button', { name: /4 Sterne/i })
    expect(starButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('submits a new rating via POST and refreshes aggregate', async () => {
    // No initial mockRatings — the GET handler below handles both fetches.
    let getCalls = 0
    let postBody: unknown = null
    server.use(
      http.get('/api/recipes/r1/ratings', () => {
        getCalls += 1
        // First fetch: empty aggregate. Subsequent fetches (triggered by
        // cache invalidation after the mutation) return the post-submit
        // state.
        if (getCalls === 1) {
          return HttpResponse.json<RatingListResponse>({
            aggregate: { avg: null, count: 0, myStars: null, myComment: null },
            ratings: [],
          })
        }
        return HttpResponse.json<RatingListResponse>({
          aggregate: { avg: 5, count: 1, myStars: 5, myComment: 'top' },
          ratings: [
            {
              userId: 'u1',
              displayName: 'U',
              stars: 5,
              comment: 'top',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        })
      }),
      http.post('/api/recipes/r1/ratings', async ({ request }) => {
        postBody = await request.json()
        return HttpResponse.json<UpsertRatingResponse>({
          aggregate: { avg: 5, count: 1, myStars: 5, myComment: 'top' },
          rating: {
            userId: 'u1',
            displayName: 'U',
            stars: 5,
            comment: 'top',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        })
      }),
    )

    renderWidget()
    await waitFor(() =>
      expect(screen.getByText(/Noch keine Bewertung/i)).toBeInTheDocument(),
    )

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /5 Sterne/i }))
    await user.type(screen.getByLabelText(/Kommentar/i), 'top')
    await user.click(screen.getByRole('button', { name: /Speichern/i }))

    await waitFor(() => expect(postBody).toEqual({ stars: 5, comment: 'top' }))
    await waitFor(() => expect(screen.getByText(/5,0/)).toBeInTheDocument())
  })

  it('delete-button clears the current user rating', async () => {
    mockRatings({
      aggregate: { avg: 4, count: 1, myStars: 4, myComment: null },
      ratings: [
        {
          userId: 'u1',
          displayName: 'U',
          stars: 4,
          comment: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    })

    let deleteCalled = false
    server.use(
      http.delete('/api/recipes/r1/ratings', () => {
        deleteCalled = true
        return new HttpResponse(null, { status: 204 })
      }),
    )

    renderWidget()
    const user = userEvent.setup()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Löschen/i })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('button', { name: /Löschen/i }))

    await waitFor(() => expect(deleteCalled).toBe(true))
  })
})
