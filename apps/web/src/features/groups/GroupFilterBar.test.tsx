import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GroupFilterBar } from './GroupFilterBar'

/**
 * `useIsMobile` reads `window.matchMedia`. jsdom ships with matchMedia
 * returning `matches: false` (= desktop) by default, which is what most
 * of these tests want. The BUG-019 regression tests below flip it to
 * `true` to exercise the mobile placeholder branch. Mirrors the helper
 * in `PhaseStepper.test.tsx`.
 */
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

/**
 * DS4 filter bar — `.filter-bar` in
 * `docs/mockups/warme-kueche-group-detail.html`.
 * Three controls: search input, filter-toggle with count badge, Zufall.
 */
describe('<GroupFilterBar />', () => {
  it('renders the search input with the supplied value', async () => {
    const onSearch = vi.fn()
    render(
      <GroupFilterBar
        searchQuery="Schnitzel"
        onSearchChange={onSearch}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const search = screen.getByRole('searchbox', { name: /suche/i })
    expect(search).toHaveValue('Schnitzel')
  })

  it('calls onSearchChange with the raw new value when the user types', async () => {
    const onSearch = vi.fn()
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={onSearch}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const search = screen.getByRole('searchbox', { name: /suche/i })
    const user = userEvent.setup()
    await user.type(search, 'Ku')
    // The controlled value starts at "" and the test doesn't re-render
    // with new props, so each keystroke shows the per-keystroke char.
    expect(onSearch).toHaveBeenCalledWith('K')
    expect(onSearch).toHaveBeenCalledWith('u')
  })

  it('renders the filter-toggle button with count badge when active filters > 0', () => {
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={3}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const toggle = screen.getByRole('button', { name: /^Filter/ })
    expect(toggle).toHaveTextContent('3')
  })

  it('does NOT render the count badge when activeFilterCount is 0', () => {
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const toggle = screen.getByRole('button', { name: /^Filter/ })
    // Only the literal "Filter" label, no numeric badge text.
    expect(toggle).not.toHaveTextContent(/\d/)
  })

  it('clicking the filter-toggle button calls onToggleFilter', async () => {
    const onToggle = vi.fn()
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={onToggle}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /^Filter/ }))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('reflects isFilterOpen via aria-expanded on the toggle', () => {
    const { rerender } = render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    expect(screen.getByRole('button', { name: /^Filter/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    rerender(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={true}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    expect(screen.getByRole('button', { name: /^Filter/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('clicking the Zufall button calls onRandomPick', async () => {
    const onRandom = vi.fn()
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={onRandom}
        isRandomPending={false}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Zufall/ }))
    expect(onRandom).toHaveBeenCalledOnce()
  })

  it('shows a pending label on the Zufall button while the random pick is running', () => {
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={true}
      />,
    )
    const btn = screen.getByRole('button', { name: /Würfle/ })
    expect(btn).toBeDisabled()
  })

  describe('regression BUG-019: responsive search placeholder', () => {
    // jsdom's default matchMedia reports matches: false (= desktop).
    // We stub per-test and restore in afterEach so other tests in the
    // suite keep seeing the desktop branch.
    const originalMatchMedia = window.matchMedia
    afterEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: originalMatchMedia,
      })
    })

    it('uses the full placeholder on desktop (md+)', () => {
      mockMatchMedia(false)
      render(
        <GroupFilterBar
          searchQuery=""
          onSearchChange={() => {}}
          activeFilterCount={0}
          isFilterOpen={false}
          onToggleFilter={() => {}}
          onRandomPick={() => {}}
          isRandomPending={false}
        />,
      )
      const search = screen.getByRole('searchbox', { name: /suche/i })
      expect(search).toHaveAttribute('placeholder', 'Rezept oder Zutat suchen…')
    })

    it('uses the short "Suchen…" placeholder on mobile (below md)', () => {
      mockMatchMedia(true)
      render(
        <GroupFilterBar
          searchQuery=""
          onSearchChange={() => {}}
          activeFilterCount={0}
          isFilterOpen={false}
          onToggleFilter={() => {}}
          onRandomPick={() => {}}
          isRandomPending={false}
        />,
      )
      const search = screen.getByRole('searchbox', { name: /suche/i })
      expect(search).toHaveAttribute('placeholder', 'Suchen…')
      // The accessible name must stay the canonical "Suche" regardless
      // of viewport — screen readers never see the shortened copy.
      expect(search).toHaveAttribute('aria-label', 'Suche')
    })
  })

  it('regression BUG-006: keeps the Zufall button inside the viewport on mobile', () => {
    // The bug was that the search-input's flex item lacked `min-w-0`,
    // so its intrinsic placeholder width forced the row wider than the
    // 375px viewport, clipping the trailing red Zufall button. Assert
    // the fix-marker class on the search container so a future refactor
    // that drops `min-w-0` re-trips this test.
    render(
      <GroupFilterBar
        searchQuery=""
        onSearchChange={() => {}}
        activeFilterCount={0}
        isFilterOpen={false}
        onToggleFilter={() => {}}
        onRandomPick={() => {}}
        isRandomPending={false}
      />,
    )
    const search = screen.getByRole('searchbox', { name: /suche/i })
    const searchContainer = search.closest('label')
    expect(searchContainer?.className).toMatch(/\bmin-w-0\b/)
    // And the Zufall button itself must still be reachable in the DOM.
    expect(screen.getByRole('button', { name: /Zufall/ })).toBeInTheDocument()
  })
})
