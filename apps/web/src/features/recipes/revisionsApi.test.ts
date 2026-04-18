import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RecipeRevisionDetail, RecipeRevisionSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { fetchRecipeRevision, fetchRecipeRevisions } from './revisionsApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('revisionsApi', () => {
  it('fetchRecipeRevisions hits GET /api/recipes/{id}/revisions', async () => {
    const stub: RecipeRevisionSummary[] = [
      {
        id: 'rev1',
        changeType: 'Edited',
        changedBy: { userId: 'u1', displayName: 'Tester' },
        diffSummary: 'Titel geändert',
        createdAt: '2026-04-18T11:00:00Z',
      },
    ]
    let called = false
    server.use(
      http.get('/api/recipes/r1/revisions', () => {
        called = true
        return HttpResponse.json(stub)
      }),
    )

    const result = await fetchRecipeRevisions('r1')
    expect(called).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].changeType).toBe('Edited')
  })

  it('fetchRecipeRevision returns the snapshot', async () => {
    const stub: RecipeRevisionDetail = {
      id: 'rev1',
      changeType: 'Created',
      changedBy: { userId: 'u1', displayName: 'Tester' },
      diffSummary: null,
      createdAt: '2026-04-18T11:00:00Z',
      snapshot: {
        title: 'Pizza',
        defaultServings: 4,
        difficulty: 1,
        ingredients: [],
        steps: [],
        tagIds: [],
      },
    }
    server.use(
      http.get('/api/recipes/r1/revisions/rev1', () => HttpResponse.json(stub)),
    )

    const result = await fetchRecipeRevision('r1', 'rev1')
    expect(result.snapshot.title).toBe('Pizza')
  })

  it('throws an ApiError on non-2xx', async () => {
    server.use(
      http.get('/api/recipes/r1/revisions', () =>
        HttpResponse.json({ code: 'forbidden', message: 'Kein Zugriff' }, { status: 403 }),
      ),
    )

    await expect(fetchRecipeRevisions('r1')).rejects.toMatchObject({ code: 'forbidden' })
  })
})
