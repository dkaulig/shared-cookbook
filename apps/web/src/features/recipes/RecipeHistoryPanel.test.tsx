import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import type {
  RecipeRevisionDetail,
  RecipeRevisionSummary,
} from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { RecipeHistoryPanel } from './RecipeHistoryPanel'

const baseRevision: RecipeRevisionSummary = {
  id: 'rev1',
  changeType: 'Created',
  changedBy: { userId: 'u1', displayName: 'Autor' },
  diffSummary: 'Rezept angelegt',
  createdAt: '2026-04-15T12:00:00Z',
}

const editedRevision: RecipeRevisionSummary = {
  id: 'rev2',
  changeType: 'Edited',
  changedBy: { userId: 'u1', displayName: 'Autor' },
  diffSummary: 'Titel geändert, 1 Zutat hinzugefügt',
  createdAt: '2026-04-18T10:00:00Z',
}

const detailStub: RecipeRevisionDetail = {
  ...baseRevision,
  snapshot: {
    title: 'Spätzle',
    description: 'Original',
    defaultServings: 4,
    prepTimeMinutes: 30,
    difficulty: 1,
    sourceUrl: null,
    ingredients: [
      { position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    ],
    steps: [{ position: 0, content: 'Mehl in eine Schüssel geben.' }],
    tagIds: [],
  },
}

const currentRecipe: RecipeRevisionDetail['snapshot'] = {
  title: 'Spätzle (neu)',
  description: 'Aktualisiert',
  defaultServings: 4,
  prepTimeMinutes: 30,
  difficulty: 1,
  sourceUrl: null,
  ingredients: [
    { position: 0, quantity: 500, unit: 'g', name: 'Mehl', note: null, scalable: true },
    { position: 1, quantity: 100, unit: 'g', name: 'Salz', note: null, scalable: true },
  ],
  steps: [{ position: 0, content: 'Mehl in eine Schüssel geben.' }],
  tagIds: [],
}

beforeEach(() => {
  useAuthStore.setState({
    accessToken: 't',
    user: { id: 'u1', email: 'u1@ex.com', displayName: 'U', role: 'User' },
  })
})

function withProviders(node: ReactNode): ReactNode {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

describe('RecipeHistoryPanel', () => {
  it('renders the German title and an empty hint when there are no revisions', async () => {
    const user = userEvent.setup()
    server.use(http.get('/api/recipes/r1/revisions', () => HttpResponse.json([])))

    render(withProviders(<RecipeHistoryPanel recipeId="r1" current={currentRecipe} />))

    expect(await screen.findByText(/Letzte Änderungen/i)).toBeInTheDocument()
    // Panel is collapsed by default — open it before asserting on the
    // empty-state hint (which only renders when the panel is open).
    await user.click(await screen.findByRole('button', { name: /Anzeigen/i }))
    expect(await screen.findByText(/Noch keine Änderungen erfasst/i)).toBeInTheDocument()
  })

  it('renders one row per revision with display name and change-type label', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1/revisions', () =>
        HttpResponse.json([editedRevision, baseRevision]),
      ),
    )

    render(withProviders(<RecipeHistoryPanel recipeId="r1" current={currentRecipe} />))

    await user.click(await screen.findByRole('button', { name: /Anzeigen/i }))

    expect(await screen.findAllByText('Autor')).toHaveLength(2)
    expect(screen.getByText(/Bearbeitet/)).toBeInTheDocument()
    expect(screen.getByText(/Angelegt/)).toBeInTheDocument()
    expect(screen.getByText(/Titel geändert, 1 Zutat hinzugefügt/)).toBeInTheDocument()
  })

  it('opens the diff modal when a row is clicked', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/recipes/r1/revisions', () => HttpResponse.json([baseRevision])),
      http.get('/api/recipes/r1/revisions/rev1', () => HttpResponse.json(detailStub)),
    )

    render(withProviders(<RecipeHistoryPanel recipeId="r1" current={currentRecipe} />))

    await user.click(await screen.findByRole('button', { name: /Anzeigen/i }))
    const row = await screen.findByRole('button', { name: /Angelegt/ })
    await user.click(row)

    // Modal heading appears.
    expect(
      await screen.findByRole('heading', { name: /Versionsvergleich/i }),
    ).toBeInTheDocument()
    // Snapshot title from the stub renders alongside the current title —
    // both show up multiple times (snapshot column header + metadata
    // diff row), so use getAllByText.
    expect(screen.getAllByText(/Spätzle \(neu\)/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Spätzle/).length).toBeGreaterThan(1)
  })
})
