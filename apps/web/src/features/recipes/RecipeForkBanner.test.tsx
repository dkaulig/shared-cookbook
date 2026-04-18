import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { RecipeForkBanner } from './RecipeForkBanner'

describe('RecipeForkBanner', () => {
  it('renders the fork-icon, origin recipe title and source-group name', () => {
    render(
      <MemoryRouter>
        <RecipeForkBanner
          originalRecipeId="orig-123"
          originalRecipeTitle="Omas Schnitzel"
          sourceGroupName="Familie Müller"
        />
      </MemoryRouter>,
    )

    // Amber-tinted banner with a visible fork glyph. The icon is aria-hidden
    // — assert the label copy + link target instead.
    expect(screen.getByText(/Geforkt aus/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Omas Schnitzel/i })
    expect(link).toHaveAttribute('href', '/recipes/orig-123')
    expect(screen.getByText(/Familie Müller/)).toBeInTheDocument()
  })

  it('still renders without a source-group name (unknown source)', () => {
    render(
      <MemoryRouter>
        <RecipeForkBanner
          originalRecipeId="orig-xyz"
          originalRecipeTitle="Unbekannt"
          sourceGroupName={null}
        />
      </MemoryRouter>,
    )
    // Link to original still present; the "Gruppe <name>" suffix is omitted.
    expect(screen.getByRole('link', { name: /Unbekannt/i })).toBeInTheDocument()
    expect(screen.queryByText(/Gruppe /i)).not.toBeInTheDocument()
  })

  it('accepts a custom className on the outer element (composition prop)', () => {
    const { container } = render(
      <MemoryRouter>
        <RecipeForkBanner
          originalRecipeId="o1"
          originalRecipeTitle="X"
          sourceGroupName="Y"
          className="custom-x"
        />
      </MemoryRouter>,
    )
    expect(container.firstElementChild).toHaveClass('custom-x')
  })
})
