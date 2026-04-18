import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeDetailPage } from './RecipeDetailPage'

const recipe: RecipeDetailDto = {
  id: 'r1',
  groupId: 'g1',
  createdByUserId: 'u1',
  createdByDisplayName: 'Autor Alice',
  title: 'Spätzle',
  description: 'Mit Käse überbacken',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: 'https://example.com/recipe',
  sourceType: 'Manual',
  forkOfRecipeId: null,
  photos: ['fake://a.jpg'],
  lastCookedAt: null,
  createdAt: '2026-04-18T00:00:00Z',
  updatedAt: '2026-04-18T00:00:00Z',
  ingredients: [
    { id: 'i1', position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    { id: 'i2', position: 1, quantity: null, unit: 'Prise', name: 'Salz', note: null, scalable: false },
  ],
  steps: [
    { id: 's1', position: 0, content: 'Mehl in eine Schüssel geben.' },
    { id: 's2', position: 1, content: 'Eier und Salz hinzufügen.' },
  ],
  tags: [{ id: 't1', name: 'deftig', category: 'Typ', isGlobal: true, groupId: null }],
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
  server.use(
    http.get('/api/recipes/r1', () => HttpResponse.json(recipe)),
    http.get('/api/groups/g1', () =>
      HttpResponse.json({
        id: 'g1',
        name: 'Familie',
        description: null,
        coverImageUrl: null,
        defaultServings: 2,
        isPrivateCollection: false,
        memberCount: 1,
        myRole: 'Admin',
        members: [],
      }),
    ),
  )
})

function withProviders(path: string): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/groups/:groupId/recipes/:recipeId" element={<RecipeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('RecipeDetailPage', () => {
  it('renders title, description, ingredients, steps and tags', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(await screen.findByRole('heading', { name: /Spätzle/ })).toBeInTheDocument()
    expect(screen.getByText('Mit Käse überbacken')).toBeInTheDocument()
    // Ingredient name rendered inside ingredient list — assert exact text.
    expect(screen.getByText('Salz')).toBeInTheDocument()
    expect(screen.getAllByText(/Mehl/)).not.toHaveLength(0)
    expect(screen.getByText('Mehl in eine Schüssel geben.')).toBeInTheDocument()
    expect(screen.getByText('deftig')).toBeInTheDocument()
  })

  it('renders a link to the source URL when present', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    const link = await screen.findByRole('link', { name: /Zur Original-Quelle/i })
    expect(link).toHaveAttribute('href', 'https://example.com/recipe')
  })

  it('renders the live portion-scaler input seeded at defaultServings', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    const input = await screen.findByLabelText(/Portionen/i)
    expect(input).toHaveValue(4)
  })

  it('renders scaled ingredient list matching default servings at initial render', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(await screen.findByText('500 g')).toBeInTheDocument()
    expect(screen.getByText('nach Geschmack')).toBeInTheDocument()
  })

  it('renders the group-default umrechnen button using the fetched group settings', async () => {
    render(withProviders('/groups/g1/recipes/r1'))
    expect(
      await screen.findByRole('button', { name: /Für Familie umrechnen \(2 Portionen\)/i }),
    ).toBeInTheDocument()
  })
})
