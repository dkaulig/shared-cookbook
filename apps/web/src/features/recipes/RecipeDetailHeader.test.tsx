import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RecipeDetailDto } from '@familien-kochbuch/shared'
import { RecipeDetailHeader } from './RecipeDetailHeader'

const RECIPE: RecipeDetailDto = {
  id: 'r1',
  groupId: 'g1',
  createdByUserId: 'u1',
  createdByDisplayName: 'Oma Ilse',
  title: 'Omas Schnitzel mit Kartoffelpüree',
  description: 'Sonntags-Klassiker — paniert und in Butter ausgebraten.',
  defaultServings: 4,
  prepTimeMinutes: 45,
  difficulty: 2,
  sourceUrl: null,
  sourceType: 'Manual',
  forkOfRecipeId: null,
  photos: ['fake://hero.jpg'],
  lastCookedAt: null,
  createdAt: '2026-04-18T00:00:00Z',
  updatedAt: '2026-04-18T00:00:00Z',
  version: 0,
  ingredients: [],
  steps: [],
  tags: [
    { id: 't1', name: 'Abend', category: 'Mahlzeit', isGlobal: true, groupId: null },
    { id: 't2', name: 'warm', category: 'Typ', isGlobal: true, groupId: null },
    { id: 't3', name: 'deutsch', category: 'Kueche', isGlobal: true, groupId: null },
  ],
}

function renderHeader(
  override: Partial<React.ComponentProps<typeof RecipeDetailHeader>> = {},
) {
  return render(
    <MemoryRouter>
      <RecipeDetailHeader
        recipe={RECIPE}
        groupId="g1"
        avgRating={4.8}
        ratingCount={12}
        sourceGroupName={null}
        onBack={() => {}}
        onFork={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        {...override}
      />
    </MemoryRouter>,
  )
}

describe('RecipeDetailHeader — title card', () => {
  it('renders the recipe title in an h1', () => {
    renderHeader()
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent(/Omas Schnitzel/i)
  })

  it('renders the italic description line', () => {
    renderHeader()
    expect(screen.getByText(/Sonntags-Klassiker/)).toBeInTheDocument()
  })

  it('renders each tag as a mini chip', () => {
    renderHeader()
    expect(screen.getByText('Abend')).toBeInTheDocument()
    expect(screen.getByText('warm')).toBeInTheDocument()
    expect(screen.getByText('deutsch')).toBeInTheDocument()
  })

  it('renders the prep time + difficulty + creator in the stat row', () => {
    renderHeader()
    expect(screen.getByText(/45 Min/i)).toBeInTheDocument()
    expect(screen.getByText(/Mittel/i)).toBeInTheDocument()
    expect(screen.getByText(/Oma Ilse/)).toBeInTheDocument()
  })

  it('renders the aggregate rating + count pill when avgRating is set', () => {
    renderHeader()
    expect(screen.getByText('4,8')).toBeInTheDocument()
    expect(screen.getByText(/\(12\)/)).toBeInTheDocument()
  })

  it('omits the rating pill when there are no ratings yet', () => {
    renderHeader({ avgRating: null, ratingCount: 0 })
    expect(screen.queryByText('4,8')).not.toBeInTheDocument()
    expect(screen.queryByText(/\(12\)/)).not.toBeInTheDocument()
  })
})

describe('RecipeDetailHeader — fork banner', () => {
  it('renders a RecipeForkBanner when forkOfRecipeId is set', () => {
    const forked = { ...RECIPE, forkOfRecipeId: 'r-original' }
    render(
      <MemoryRouter>
        <RecipeDetailHeader
          recipe={forked}
          groupId="g1"
          avgRating={null}
          ratingCount={0}
          sourceGroupName="Example Family"
          onBack={() => {}}
          onFork={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Geforkt aus/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Omas Schnitzel/i })).toHaveAttribute(
      'href',
      '/recipes/r-original',
    )
  })

  it('does not render the fork banner for original recipes', () => {
    renderHeader()
    expect(screen.queryByText(/Geforkt aus/i)).not.toBeInTheDocument()
  })
})

describe('RecipeDetailHeader — top-bar icon buttons', () => {
  it('calls onBack when the back button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn()
    renderHeader({ onBack: handler })
    await user.click(screen.getByRole('button', { name: /Zurück/i }))
    expect(handler).toHaveBeenCalled()
  })

  it('exposes fork, edit and delete actions under an overflow menu', async () => {
    const user = userEvent.setup()
    const fork = vi.fn()
    const edit = vi.fn()
    const del = vi.fn()
    renderHeader({ onFork: fork, onEdit: edit, onDelete: del })
    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(screen.getByRole('menuitem', { name: /In andere Gruppe kopieren/i }))
    expect(fork).toHaveBeenCalled()

    // Re-open the menu; first click closed it.
    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(screen.getByRole('menuitem', { name: /Bearbeiten/i }))
    expect(edit).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /Mehr/i }))
    await user.click(screen.getByRole('menuitem', { name: /Löschen/i }))
    expect(del).toHaveBeenCalled()
  })
})

describe('RecipeDetailHeader — hero photo', () => {
  it('renders the first photo as an <img> with the recipe title as alt text', () => {
    renderHeader()
    const img = screen.getByRole('img', { name: /Omas Schnitzel/i })
    expect(img).toHaveAttribute('src', 'fake://hero.jpg')
  })

  it('renders a photo counter "Foto 1 / N" when photos are present', () => {
    const multi = {
      ...RECIPE,
      photos: ['fake://a.jpg', 'fake://b.jpg', 'fake://c.jpg'],
    }
    render(
      <MemoryRouter>
        <RecipeDetailHeader
          recipe={multi}
          groupId="g1"
          avgRating={null}
          ratingCount={0}
          sourceGroupName={null}
          onBack={() => {}}
          onFork={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Foto 1 \/ 3/)).toBeInTheDocument()
  })

  it('falls back to a gradient placeholder when there are no photos', () => {
    const noPhoto = { ...RECIPE, photos: [] }
    render(
      <MemoryRouter>
        <RecipeDetailHeader
          recipe={noPhoto}
          groupId="g1"
          avgRating={null}
          ratingCount={0}
          sourceGroupName={null}
          onBack={() => {}}
          onFork={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const hero = screen.getByTestId('hero-surface')
    // Gradient style is applied inline so we can assert it carries a
    // linear-gradient fragment.
    expect(hero.getAttribute('style')).toContain('linear-gradient')
  })
})
