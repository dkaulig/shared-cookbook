import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { RecipeSummaryDto, TagDto } from '@familien-kochbuch/shared'
import { RecipeGridCard } from './RecipeGridCard'

/**
 * DS4 compact recipe card used in the Group Detail grid
 * (`.recipe-card` in the mockup, retinted for DS8 Sage Modern).
 * Renders a 4:3 photo (gradient or URL fallback) with an optional
 * rating pill overlay, a display `font-serif` title (Inter under
 * DS8), a minute/creator meta line, and up to two mini-tag chips.
 */

const base: RecipeSummaryDto = {
  id: 'r1',
  groupId: 'g1',
  title: 'Omas Schnitzel',
  description: null,
  photo: null,
  tagIds: ['t1'],
  createdByDisplayName: 'Oma',
  updatedAt: '2026-04-01T00:00:00Z',
  avgRating: 4.8,
  ratingCount: 12,
  myStars: null,
}

const tags: TagDto[] = [
  { id: 't1', name: 'Abend', category: 'Mahlzeit', isGlobal: true, groupId: null, createdByUserId: null },
  { id: 't2', name: 'deftig', category: 'Typ', isGlobal: true, groupId: null, createdByUserId: null },
]

function withRouter(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

describe('<RecipeGridCard />', () => {
  it('renders the title as a link into the recipe detail route', () => {
    render(withRouter(<RecipeGridCard recipe={base} tags={tags} prepTimeMinutes={45} />))
    const link = screen.getByRole('link', { name: /Omas Schnitzel/ })
    expect(link).toHaveAttribute('href', '/groups/g1/recipes/r1')
  })

  it('renders the rating pill when avgRating is set', () => {
    render(withRouter(<RecipeGridCard recipe={base} tags={tags} prepTimeMinutes={45} />))
    // German decimal formatting: 4,8
    expect(screen.getByText('4,8')).toBeInTheDocument()
  })

  it('hides the rating pill when avgRating is null', () => {
    render(
      withRouter(
        <RecipeGridCard
          recipe={{ ...base, avgRating: null, ratingCount: 0 }}
          tags={tags}
          prepTimeMinutes={45}
        />,
      ),
    )
    expect(screen.queryByText(/\d,\d/)).not.toBeInTheDocument()
  })

  it('renders the prepTime and creator meta line', () => {
    render(withRouter(<RecipeGridCard recipe={base} tags={tags} prepTimeMinutes={45} />))
    expect(screen.getByText(/45 Min/)).toBeInTheDocument()
    expect(screen.getByText('Oma')).toBeInTheDocument()
  })

  it('renders up to two mini-tag chips from the resolved tag names', () => {
    render(
      withRouter(
        <RecipeGridCard
          recipe={{ ...base, tagIds: ['t1', 't2'] }}
          tags={tags}
          prepTimeMinutes={45}
        />,
      ),
    )
    expect(screen.getByText('Abend')).toBeInTheDocument()
    expect(screen.getByText('deftig')).toBeInTheDocument()
  })

  it('uses the real photo URL when recipe.photo is set', () => {
    const withPhoto = { ...base, photo: 'https://example.com/pic.jpg' }
    render(withRouter(<RecipeGridCard recipe={withPhoto} tags={tags} prepTimeMinutes={45} />))
    const photo = screen.getByTestId('recipe-photo')
    // Style property holds the `url(...)` background image.
    expect(photo.getAttribute('style') ?? '').toContain('pic.jpg')
  })

  it('falls back to a deterministic gradient when no photo is set', () => {
    render(withRouter(<RecipeGridCard recipe={base} tags={tags} prepTimeMinutes={45} />))
    const photo = screen.getByTestId('recipe-photo')
    expect(photo.getAttribute('style') ?? '').toContain('gradient')
  })
})
