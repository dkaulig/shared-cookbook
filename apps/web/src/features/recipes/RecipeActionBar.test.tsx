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
        <Route
          path="/groups/:groupId/recipes/:recipeId/cook"
          element={<div>cook-mode-page</div>}
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

  it('COOK-0: renders a "Jetzt kochen" button that navigates to the cook route', async () => {
    const user = userEvent.setup()
    renderBar({ groupId: 'g1', recipeId: 'r1' })
    const cookBtn = screen.getByRole('button', { name: /Jetzt kochen/i })
    expect(cookBtn).toBeInTheDocument()
    await user.click(cookBtn)
    await waitFor(() => {
      expect(screen.getByTestId('loc')).toHaveTextContent('/groups/g1/recipes/r1/cook')
    })
    expect(screen.getByText('cook-mode-page')).toBeInTheDocument()
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

  // ───────── BUG-036 regression — no more self-fixed wrapper ─────────

  // The bar used to render a `<div className="pointer-events-none fixed
  // inset-x-0 z-40 …">` wrapper that hand-positioned itself above the
  // BottomNav. BUG-036 migrated the buttons into the unified Bottom-
  // Zone slot; the component must no longer render any `fixed` outer
  // container of its own around the buttons.
  it('does not render its own fixed-positioned button container (BUG-036)', () => {
    const { container } = renderBar()
    // The only acceptable `fixed` element is the transient status/error
    // toast — and that only exists AFTER a click. On initial render
    // there must be zero fixed elements.
    const fixedElements = container.querySelectorAll('div.fixed, div.pointer-events-none.fixed')
    expect(fixedElements).toHaveLength(0)
  })

  it('buttons render as direct flex items (not wrapped in a bubble container) (BUG-036)', () => {
    renderBar()
    const btn = screen.getByRole('button', { name: /In Wochenplan/i })
    // In the Bottom-Zone slot, the parent owns the flex row; the button
    // itself must carry `flex-1`.
    expect(btn.className).toMatch(/\bflex-1\b/)
  })

  // ───────── BUG-021 legacy note ─────────

  // BUG-021 originally asserted the bar stacked above BottomNav via
  // `z-40`. With BUG-036 the bar no longer positions itself — both the
  // buttons and the BottomNav share the same z-30 container, so the
  // stacking question is moot. We keep one anchoring test that the
  // source file doesn't regress to a single-digit arbitrary z-index.
  it('does not use a z-index below 30 anywhere in RecipeActionBar.tsx', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, './RecipeActionBar.tsx'), 'utf8')
    // `z-[N]` where N is a single digit would sit well below BottomNav's
    // z-30. The bar previously had `z-[8]`; guard against any regression
    // that re-introduces a single-digit arbitrary z.
    expect(source).not.toMatch(/z-\[[0-9]\]/)
  })
})
