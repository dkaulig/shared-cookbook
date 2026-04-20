import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import type { ExtractionResult } from '@familien-kochbuch/shared'
import {
  convertChatToRecipe,
  sendChatTurn,
  type LegacyChatMessage,
} from './chatApi'

/**
 * CR2 — the backend swap from P2-6 Python proxy to native .NET SSE
 * surface removed `POST /api/chat` outright. This test file exercises
 * the thin compat shim: `sendChatTurn` still POSTs to the legacy path
 * (so `ChatPage.tsx` keeps compiling until CR4 rewrites the UI), and
 * `convertChatToRecipe` has switched to the new session-scoped path at
 * `/api/chat/sessions/:id/to-recipe` with no body.
 */

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

const sampleMessages: LegacyChatMessage[] = [
  { role: 'user', content: 'Ich hab Kartoffeln, Quark und Lauch. Vegan bitte.' },
  { role: 'assistant', content: 'Wie viele Portionen?' },
  { role: 'user', content: '4 Portionen.' },
]

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
    thumbnail_url: null,
  },
  confidence: { overall: 'medium', notes: [] },
}

describe('chatApi — sendChatTurn (legacy compat)', () => {
  it('still targets the legacy POST /api/chat path (until CR4 swap)', async () => {
    let captured: { sessionId: string; messages: LegacyChatMessage[] } | null = null
    server.use(
      http.post('/api/chat', async ({ request }) => {
        captured = (await request.json()) as {
          sessionId: string
          messages: LegacyChatMessage[]
        }
        return HttpResponse.json({
          assistant_message: 'Probier Kartoffel-Lauch-Auflauf.',
        })
      }),
    )
    const res = await sendChatTurn({
      sessionId: 'abc-123',
      messages: sampleMessages,
    })
    expect(res.assistantMessage).toContain('Kartoffel')
    expect(captured).not.toBeNull()
    expect(captured!.sessionId).toBe('abc-123')
    expect(captured!.messages).toHaveLength(3)
  })

  it('maps snake_case wire `assistant_message` → camelCase `assistantMessage`', async () => {
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json({ assistant_message: 'Hallo Welt' }),
      ),
    )
    const res = await sendChatTurn({
      sessionId: 'abc',
      messages: [{ role: 'user', content: 'Hi' }],
    })
    expect(res).toEqual({ assistantMessage: 'Hallo Welt' })
  })
})

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

describe('chatApi — BUG-026 regression-grep gate', () => {
  // A purely-textual check: if someone removes the snake→camel mapper
  // and types the wire as camelCase, the mapper re-regresses silently.
  // This asserts the literal `assistant_message` (snake_case) still
  // appears in the source so the mismatch surfaces in the PR diff.
  it('chatApi.ts still declares the snake_case wire key `assistant_message`', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './chatApi.ts'), 'utf8')
    expect(source).toMatch(/assistant_message/)
  })
})
