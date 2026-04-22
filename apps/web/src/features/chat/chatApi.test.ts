import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import type { ExtractionResult } from '@familien-kochbuch/shared'
import { convertChatToRecipe } from './chatApi'

/**
 * Tests focus on the surviving REST surface of `chatApi.ts` — session
 * list / create / rename / delete / messages + the `to-recipe`
 * conversion proxy. Turn submission is SSE and lives in
 * `sseChatStream.ts` with its own test file.
 */

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

const sampleResult: ExtractionResult = {
  recipe: {
    title: 'Veganer Kartoffel-Lauch-Auflauf',
    description: null,
    servings: 4,
    difficulty: 1,
    prep_minutes: 20,
    cook_minutes: 30,
    ingredients: [],
    steps: [],
    tags: ['vegan'],
    source_url: 'chat://session/abc',
  },
  confidence: { overall: 'medium', notes: [] },
}

describe('chatApi — convertChatToRecipe (CR2 path)', () => {
  it('POSTs to the new /api/chat/sessions/:id/to-recipe path with no body', async () => {
    let capturedUrl = ''
    let capturedBody: string | null = null
    server.use(
      http.post('/api/chat/sessions/:sessionId/to-recipe', async ({ request, params }) => {
        capturedUrl = String(params.sessionId)
        capturedBody = await request.text()
        return HttpResponse.json(sampleResult)
      }),
    )
    const res = await convertChatToRecipe('abc-123')
    expect(res.recipe.title).toContain('Kartoffel')
    expect(res.confidence.overall).toBe('medium')
    expect(capturedUrl).toBe('abc-123')
    // CR2: the frontend no longer sends a body — the server loads the
    // message list from the DB.
    expect(capturedBody ?? '').toBe('')
  })

  it('URL-encodes the sessionId so special characters do not break the path', async () => {
    let capturedPath = ''
    server.use(
      http.post('/api/chat/sessions/:sessionId/to-recipe', ({ request }) => {
        capturedPath = new URL(request.url).pathname
        return HttpResponse.json(sampleResult)
      }),
    )
    await convertChatToRecipe('abc/slash?weird')
    expect(capturedPath).toContain(encodeURIComponent('abc/slash?weird'))
  })

  it('throws an ApiError on 400 when the chat could not be structured', async () => {
    server.use(
      http.post('/api/chat/sessions/:sessionId/to-recipe', () =>
        HttpResponse.json(
          {
            code: 'not_a_recipe',
            message:
              'Der Dialog enthält noch kein klares Rezept — führe den Chat etwas weiter.',
          },
          { status: 400 },
        ),
      ),
    )
    await expect(convertChatToRecipe('abc')).rejects.toThrow(
      /noch kein klares Rezept/,
    )
  })
})
