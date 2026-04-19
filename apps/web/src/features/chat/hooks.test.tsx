import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useChatTurn, useConvertChatToRecipe } from './hooks'

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('useChatTurn', () => {
  it('POSTs sessionId + messages and resolves with the assistantMessage', async () => {
    server.use(
      http.post('/api/chat', async () =>
        HttpResponse.json({ assistantMessage: 'Wie viele Portionen?' }),
      ),
    )
    const { result } = renderHook(() => useChatTurn(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.mutateAsync({
      sessionId: 's1',
      messages: [{ role: 'user', content: 'Hallo' }],
    })
    expect(res.assistantMessage).toContain('Portionen')
  })

  it('surfaces backend error messages through the mutation', async () => {
    server.use(
      http.post('/api/chat', () =>
        HttpResponse.json(
          { code: 'llm_unavailable', message: 'KI-Service offline.' },
          { status: 503 },
        ),
      ),
    )
    const { result } = renderHook(() => useChatTurn(), {
      wrapper: makeWrapper(),
    })
    await expect(
      result.current.mutateAsync({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'Hallo' }],
      }),
    ).rejects.toThrow(/offline/)
  })
})

describe('useConvertChatToRecipe', () => {
  it('POSTs the messages to the session-scoped URL and returns the ExtractionResult', async () => {
    server.use(
      http.post('/api/chat/:sessionId/to-recipe', async () =>
        HttpResponse.json({
          recipe: {
            title: 'Omelette',
            description: null,
            servings: 2,
            difficulty: 1,
            prep_minutes: 5,
            cook_minutes: 10,
            ingredients: [],
            steps: [],
            tags: [],
            source_url: 'chat://abc',
            thumbnail_url: null,
          },
          confidence: { overall: 'high', notes: [] },
        }),
      ),
    )
    const { result } = renderHook(() => useConvertChatToRecipe(), {
      wrapper: makeWrapper(),
    })
    const res = await result.current.mutateAsync({
      sessionId: 'abc',
      messages: [
        { role: 'user', content: 'Zwei Eier, Butter, Salz' },
        { role: 'assistant', content: 'Perfekt, ein Omelette.' },
      ],
    })
    expect(res.recipe.title).toBe('Omelette')
    expect(res.confidence.overall).toBe('high')
  })
})
