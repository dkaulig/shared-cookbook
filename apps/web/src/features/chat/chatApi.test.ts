import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import type {
  ChatMessage,
  ExtractionResult,
} from '@familien-kochbuch/shared'
import { convertChatToRecipe, sendChatTurn } from './chatApi'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

const sampleMessages: ChatMessage[] = [
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

describe('chatApi — sendChatTurn (POST /api/chat)', () => {
  it('posts sessionId + messages and resolves with the assistant reply', async () => {
    let captured: { sessionId: string; messages: ChatMessage[] } | null = null
    server.use(
      http.post('/api/chat', async ({ request }) => {
        captured = (await request.json()) as {
          sessionId: string
          messages: ChatMessage[]
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

  it('BUG-026 — maps snake_case wire `assistant_message` → camelCase `assistantMessage`', async () => {
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
    expect(res.assistantMessage).toBe('Hallo Welt')
  })

  it('throws an ApiError on 413 turn-cap overflow', async () => {
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json(
          {
            code: 'too_many_messages',
            message: 'Dialog ist zu lang. Bitte starte einen neuen Chat.',
          },
          { status: 413 },
        ),
      ),
    )
    await expect(
      sendChatTurn({
        sessionId: 'full',
        messages: sampleMessages,
      }),
    ).rejects.toThrow(/zu lang/i)
  })

  it('throws an ApiError on 503 when the LLM provider is down', async () => {
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json(
          {
            code: 'llm_unavailable',
            message: 'KI-Service momentan nicht erreichbar.',
          },
          { status: 503 },
        ),
      ),
    )
    await expect(
      sendChatTurn({ sessionId: 'abc', messages: sampleMessages }),
    ).rejects.toThrow(/KI-Service/)
  })
})

describe('chatApi — convertChatToRecipe (POST /api/chat/:session/to-recipe)', () => {
  it('posts messages to the session-scoped URL and returns the ExtractionResult', async () => {
    let captured: { messages: ChatMessage[] } | null = null
    let capturedUrl = ''
    server.use(
      http.post('/api/chat/:sessionId/to-recipe', async ({ request, params }) => {
        capturedUrl = String(params.sessionId)
        captured = (await request.json()) as { messages: ChatMessage[] }
        return HttpResponse.json(sampleResult)
      }),
    )
    const res = await convertChatToRecipe('abc-123', sampleMessages)
    expect(res.recipe.title).toContain('Kartoffel')
    expect(res.confidence.overall).toBe('medium')
    expect(capturedUrl).toBe('abc-123')
    expect(captured).not.toBeNull()
    expect(captured!.messages).toHaveLength(3)
  })

  it('URL-encodes the sessionId so special characters do not break the path', async () => {
    let capturedPath = ''
    server.use(
      http.post('/api/chat/:sessionId/to-recipe', ({ request }) => {
        capturedPath = new URL(request.url).pathname
        return HttpResponse.json(sampleResult)
      }),
    )
    await convertChatToRecipe('abc/slash?weird', sampleMessages)
    expect(capturedPath).toContain(encodeURIComponent('abc/slash?weird'))
  })

  it('throws an ApiError on 400 when the chat could not be structured', async () => {
    server.use(
      http.post('/api/chat/:sessionId/to-recipe', () =>
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
    await expect(
      convertChatToRecipe('abc', sampleMessages),
    ).rejects.toThrow(/noch kein klares Rezept/)
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
