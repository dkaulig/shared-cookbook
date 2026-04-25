import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RecipeSearchResult, RandomRecipeResponse } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { fetchRandomRecipe, searchRecipes } from './searchApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

describe('searchApi', () => {
  it('searchRecipes serializes q + tags + minRating + sort into query params', async () => {
    let captured = ''
    server.use(
      http.get('/api/groups/g1/recipes/search', ({ request }) => {
        captured = new URL(request.url).search
        return HttpResponse.json<RecipeSearchResult>({
          items: [], page: 1, pageSize: 20, total: 0,
        })
      }),
    )

    await searchRecipes('g1', {
      q: 'Nudeln',
      tags: ['t1', 't2'],
      minRating: 4,
      sort: 'best_rated',
      page: 2,
      pageSize: 10,
    })

    expect(captured).toContain('q=Nudeln')
    expect(captured).toContain('tags=t1%2Ct2')
    expect(captured).toContain('minRating=4')
    expect(captured).toContain('sort=best_rated')
    expect(captured).toContain('page=2')
    expect(captured).toContain('pageSize=10')
  })

  it('searchRecipes omits undefined params', async () => {
    let captured = ''
    server.use(
      http.get('/api/groups/g1/recipes/search', ({ request }) => {
        captured = new URL(request.url).search
        return HttpResponse.json<RecipeSearchResult>({
          items: [], page: 1, pageSize: 20, total: 0,
        })
      }),
    )
    await searchRecipes('g1', {})
    expect(captured).not.toContain('q=')
    expect(captured).not.toContain('tags=')
  })

  it('fetchRandomRecipe calls the random endpoint with the same filters', async () => {
    let captured = ''
    server.use(
      http.get('/api/groups/g1/recipes/random', ({ request }) => {
        captured = new URL(request.url).search
        return HttpResponse.json<RandomRecipeResponse>({ recipeId: 'r1' })
      }),
    )
    const result = await fetchRandomRecipe('g1', { q: 'Nudeln' })
    expect(captured).toContain('q=Nudeln')
    expect(result.recipeId).toBe('r1')
  })
})
