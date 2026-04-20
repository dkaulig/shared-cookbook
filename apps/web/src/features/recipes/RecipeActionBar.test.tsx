import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { toMondayIso } from '@/features/mealplanning/weekGrid'
import { RecipeActionBar } from './RecipeActionBar'

const TODAY_MONDAY = toMondayIso(new Date().toISOString().slice(0, 10))

function LocationProbe() {
  const loc = useLocation()
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  )
}

function renderBar(
  props: Partial<React.ComponentProps<typeof RecipeActionBar>> = {},
) {
  const merged: React.ComponentProps<typeof RecipeActionBar> = {
    groupId: 'g1',
    recipeId: 'r1',
    onMarkCooked: () => Promise.resolve(),
    markCookedPending: false,
    ...props,
  }
  return render(
    <MemoryRouter initialEntries={['/groups/g1/recipes/r1']}>
      <LocationProbe />
      <Routes>
        <Route path="/groups/g1/recipes/r1" element={<RecipeActionBar {...merged} />} />
        <Route
          path="/groups/:groupId/mealplan/:weekStart"
          element={<div>mealplan-page</div>}
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('RecipeActionBar', () => {
  it('renders the ghost "In Wochenplan" + primary "Jetzt gekocht" buttons', () => {
    renderBar()
    expect(screen.getByRole('button', { name: /In Wochenplan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Jetzt gekocht/i })).toBeInTheDocument()
  })

  it('fires onMarkCooked when the primary button is clicked', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockResolvedValue(undefined)
    renderBar({ onMarkCooked: handler })
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disables the Jetzt-gekocht button while a mutation is pending', () => {
    renderBar({ markCookedPending: true })
    expect(screen.getByRole('button', { name: /Jetzt gekocht/i })).toBeDisabled()
  })

  it('shows a transient "wurde als gekocht markiert" message on success', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockResolvedValue(undefined)
    renderBar({ onMarkCooked: handler })
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/als gekocht markiert/i)
    })
  })

  it('navigates to the group\'s mealplan with addRecipeId on Wochenplan click', async () => {
    const user = userEvent.setup()
    renderBar({ groupId: 'g42', recipeId: 'r99' })

    await user.click(screen.getByRole('button', { name: /In Wochenplan/i }))

    await waitFor(() => {
      expect(screen.getByTestId('loc')).toHaveTextContent(
        `/groups/g42/mealplan/${TODAY_MONDAY}?addRecipeId=r99`,
      )
    })
    expect(screen.getByText('mealplan-page')).toBeInTheDocument()
  })

  it('does not surface the legacy "Phase 3" placeholder status anymore', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByRole('button', { name: /In Wochenplan/i }))
    expect(screen.queryByText(/Phase 3/i)).not.toBeInTheDocument()
  })

  it('surfaces an error message when the mark-cooked mutation rejects', async () => {
    const user = userEvent.setup()
    const handler = vi.fn().mockRejectedValue(new Error('api_down: offline'))
    renderBar({ onMarkCooked: handler })
    await user.click(screen.getByRole('button', { name: /Jetzt gekocht/i }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/offline/i)
    })
  })

  // ───────── BUG-021 regression ─────────

  it('stacks the action bar above BottomNav (z >= 30)', () => {
    const { container } = renderBar()
    // The ActionBar wrapper is the first fixed div. jsdom does not expand
    // Tailwind arbitrary values via getComputedStyle, so fall back to a
    // grep-style className assertion (documented in the BUG-021 backlog
    // entry test-strategy).
    const fixedBar = container.querySelector('div.fixed')
    expect(fixedBar).not.toBeNull()
    expect(fixedBar!.className).toMatch(/\bz-40\b/)
  })

  it('does not use a z-index below 30 anywhere in RecipeActionBar.tsx', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './RecipeActionBar.tsx'), 'utf8')
    // `z-[N]` where N is a single digit would sit well below BottomNav's
    // z-30. The bar previously had `z-[8]`; guard against any regression
    // that re-introduces a single-digit arbitrary z.
    expect(source).not.toMatch(/z-\[[0-9]\]/)
  })

  it('pins the bottom offset to the --bottom-nav-height token (not a hard-coded 72px)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './RecipeActionBar.tsx'), 'utf8')
    expect(source).toMatch(/--bottom-nav-height/)
    expect(source).not.toMatch(/env\(safe-area-inset-bottom,0px\)\+72px/)
  })
})
