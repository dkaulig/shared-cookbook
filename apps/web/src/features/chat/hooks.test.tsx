import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { useConvertChatToRecipe } from './hooks'

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

describe('useConvertChatToRecipe', () => {
  it('POSTs the session id to the session-scoped URL and returns the ExtractionResult', async () => {
    server.use(
      http.post('/api/chat/sessions/:sessionId/to-recipe', async () =>
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
    const res = await result.current.mutateAsync({ sessionId: 'abc' })
    expect(res.recipe.title).toBe('Omelette')
    expect(res.confidence.overall).toBe('high')
  })
})
