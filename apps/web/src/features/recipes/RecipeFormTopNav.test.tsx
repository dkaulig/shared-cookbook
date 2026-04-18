import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecipeFormTopNav } from './RecipeFormTopNav'

function renderTopNav(
  override: Partial<React.ComponentProps<typeof RecipeFormTopNav>> = {},
) {
  return render(
    <MemoryRouter>
      <RecipeFormTopNav mode="create" onCancel={() => {}} {...override} />
    </MemoryRouter>,
  )
}

describe('<RecipeFormTopNav />', () => {
  it('shows "Neues Rezept" as the title in create mode', () => {
    renderTopNav({ mode: 'create' })
    expect(screen.getByText(/Neues Rezept/)).toBeInTheDocument()
  })

  it('shows "Rezept bearbeiten" as the title in edit mode', () => {
    renderTopNav({ mode: 'edit' })
    expect(screen.getByText(/Rezept bearbeiten/)).toBeInTheDocument()
  })

  it('renders the draft tagline "Ungespeicherte Änderungen" under the title', () => {
    renderTopNav()
    expect(screen.getByText(/Ungespeicherte Änderungen/i)).toBeInTheDocument()
  })

  it('renders a German-labelled cancel icon button', () => {
    renderTopNav()
    expect(screen.getByRole('button', { name: /Abbrechen/i })).toBeInTheDocument()
  })

  it('fires onCancel when the X button is tapped', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    renderTopNav({ onCancel })
    await user.click(screen.getByRole('button', { name: /Abbrechen/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('exposes a more-menu placeholder button with aria-label "Mehr"', () => {
    renderTopNav()
    expect(screen.getByRole('button', { name: /^Mehr$/ })).toBeInTheDocument()
  })

  it('renders with the sticky top positioning class', () => {
    const { container } = renderTopNav()
    const header = container.querySelector('header')
    expect(header).not.toBeNull()
    expect(header?.className).toMatch(/sticky/)
  })
})
