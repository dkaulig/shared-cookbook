import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type {
  CreateRecipeRequest,
  RecipeDetailDto,
  RecipeSummaryListDto,
  TagDto,
} from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import {
  createRecipe,
  deleteRecipe,
  deleteRecipePhoto,
  fetchGroupRecipes,
  fetchGroupTags,
  fetchRecipe,
  updateRecipe,
  uploadRecipePhoto,
} from './recipesApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 'test-token',
    user: {
      id: 'u1',
      email: 'u1@example.com',
      displayName: 'Tester',
      role: 'User',
    },
  })
})

describe('recipesApi', () => {
  it('fetchGroupRecipes issues GET with group id and page params', async () => {
    let hitUrl = ''
    server.use(
      http.get('/api/groups/g1/recipes', ({ request }) => {
        hitUrl = request.url
        return HttpResponse.json<RecipeSummaryListDto>({
          items: [],
          page: 1,
          pageSize: 20,
          total: 0,
        })
      }),
    )

    const result = await fetchGroupRecipes('g1', 2, 10)
    expect(hitUrl).toContain('/api/groups/g1/recipes?page=2&pageSize=10')
    expect(result.total).toBe(0)
  })

  it('createRecipe POSTs JSON body and returns detail dto', async () => {
    const stub: RecipeDetailDto = {
      id: 'r1',
      groupId: 'g1',
      createdByUserId: 'u1',
      createdByDisplayName: 'Tester',
      title: 'Spätzle',
      description: null,
      defaultServings: 4,
      prepTimeMinutes: null,
      difficulty: 1,
      sourceUrl: null,
      sourceType: 'Manual',
      forkOfRecipeId: null,
      photos: [],
      lastCookedAt: null,
      createdAt: '2026-04-18T00:00:00Z',
      updatedAt: '2026-04-18T00:00:00Z',
      ingredients: [],
      steps: [],
      tags: [],
    }
    let receivedBody: CreateRecipeRequest | null = null
    server.use(
      http.post('/api/groups/g1/recipes', async ({ request }) => {
        receivedBody = (await request.json()) as CreateRecipeRequest
        return HttpResponse.json(stub, { status: 201 })
      }),
    )

    const body: CreateRecipeRequest = {
      title: 'Spätzle',
      defaultServings: 4,
      difficulty: 1,
      ingredients: [],
      steps: [],
      tagIds: [],
    }
    const result = await createRecipe('g1', body)
    expect(result.id).toBe('r1')
    expect(receivedBody).toEqual(body)
  })

  it('fetchRecipe returns detail', async () => {
    server.use(
      http.get('/api/recipes/r1', () => HttpResponse.json({ id: 'r1', title: 'X' } as unknown as RecipeDetailDto)),
    )
    const r = await fetchRecipe('r1')
    expect(r.id).toBe('r1')
  })

  it('updateRecipe PUTs JSON body', async () => {
    let called = false
    server.use(
      http.put('/api/recipes/r1', () => {
        called = true
        return HttpResponse.json({ id: 'r1', title: 'Z' } as unknown as RecipeDetailDto)
      }),
    )
    await updateRecipe('r1', {
      title: 'Z',
      defaultServings: 4,
      difficulty: 1,
      ingredients: [],
      steps: [],
      tagIds: [],
    })
    expect(called).toBe(true)
  })

  it('deleteRecipe issues DELETE', async () => {
    let called = false
    server.use(
      http.delete('/api/recipes/r1', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await deleteRecipe('r1')
    expect(called).toBe(true)
  })

  it('uploadRecipePhoto posts multipart form and returns url', async () => {
    server.use(
      http.post('/api/recipes/r1/photos', () =>
        HttpResponse.json({ url: 'fake://abc.png' }),
      ),
    )
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    const res = await uploadRecipePhoto('r1', file)
    expect(res.url).toBe('fake://abc.png')
  })

  it('deleteRecipePhoto issues DELETE with JSON body', async () => {
    let receivedUrl = ''
    server.use(
      http.delete('/api/recipes/r1/photos', async ({ request }) => {
        const body = (await request.json()) as { url: string }
        receivedUrl = body.url
        return new HttpResponse(null, { status: 204 })
      }),
    )
    await deleteRecipePhoto('r1', 'fake://abc.png')
    expect(receivedUrl).toBe('fake://abc.png')
  })

  it('fetchGroupTags returns array of tags', async () => {
    const tags: TagDto[] = [
      { id: 't1', name: 'vegan', category: 'Diaet', isGlobal: true, groupId: null },
    ]
    server.use(http.get('/api/groups/g1/tags', () => HttpResponse.json(tags)))
    const r = await fetchGroupTags('g1')
    expect(r).toHaveLength(1)
    expect(r[0].name).toBe('vegan')
  })
})
