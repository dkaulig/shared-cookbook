import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SplitPane } from './SplitPane'

/**
 * TABLET-1 — SplitPane primitive spec.
 *
 * Renders a two-column grid with the left column width fixed by the
 * `--split-left-width` CSS token (340 px by default) and the right
 * column flexible. Below the `md:` breakpoint only the left slot is
 * painted — the page's existing mobile flow handles the detail route
 * via navigation as before.
 *
 * Both slots are landmark regions (`<section aria-label="…">`) and
 * each is independently scrollable (`overflow-y-auto`) so the user can
 * scroll the list without dragging the detail with it.
 */
describe('<SplitPane />', () => {
  it('renders both slots as landmark regions with the provided aria-labels', () => {
    render(
      <SplitPane
        leftLabel="Rezept-Liste"
        rightLabel="Rezept-Detail"
        left={<div data-testid="left-content">LIST</div>}
        right={<div data-testid="right-content">DETAIL</div>}
      />,
    )
    const left = screen.getByRole('region', { name: /rezept-liste/i })
    const right = screen.getByRole('region', { name: /rezept-detail/i })
    expect(left).toContainElement(screen.getByTestId('left-content'))
    expect(right).toContainElement(screen.getByTestId('right-content'))
  })

  it('hides the right slot at < md (tailwind md:block brings it back in)', () => {
    render(
      <SplitPane
        leftLabel="Rezept-Liste"
        rightLabel="Rezept-Detail"
        left={<div>LEFT</div>}
        right={<div data-testid="right-content">RIGHT</div>}
      />,
    )
    const right = screen.getByRole('region', { name: /rezept-detail/i, hidden: true })
    // The right slot is hidden by default (`hidden`) and re-enabled at
    // the md breakpoint (`md:block`). Tailwind's `hidden` utility maps
    // to `display: none`, which jsdom can't compute — we assert on the
    // className tokens directly.
    expect(right.className).toMatch(/\bhidden\b/)
    expect(right.className).toMatch(/\bmd:block\b/)
  })

  it('uses a CSS grid with the --split-left-width token for the left column at md+', () => {
    const { container } = render(
      <SplitPane
        leftLabel="Rezept-Liste"
        rightLabel="Rezept-Detail"
        left={<div>LEFT</div>}
        right={<div>RIGHT</div>}
      />,
    )
    const root = container.firstElementChild as HTMLElement | null
    expect(root).not.toBeNull()
    // Grid only kicks in at md+: below that the pane renders the left
    // column inline-block-style.
    expect(root!.className).toMatch(/\bmd:grid\b/)
    expect(root!.className).toMatch(/md:grid-cols-\[var\(--split-left-width\)_1fr\]/)
  })

  it('gives each slot an independent scroll container (overflow-y-auto)', () => {
    render(
      <SplitPane
        leftLabel="Rezept-Liste"
        rightLabel="Rezept-Detail"
        left={<div>LEFT</div>}
        right={<div>RIGHT</div>}
      />,
    )
    const left = screen.getByRole('region', { name: /rezept-liste/i })
    const right = screen.getByRole('region', { name: /rezept-detail/i, hidden: true })
    expect(left.className).toMatch(/\boverflow-y-auto\b/)
    expect(right.className).toMatch(/\boverflow-y-auto\b/)
  })

  it('accepts an optional className forwarded onto the outer grid', () => {
    const { container } = render(
      <SplitPane
        leftLabel="Rezept-Liste"
        rightLabel="Rezept-Detail"
        left={<div>LEFT</div>}
        right={<div>RIGHT</div>}
        className="custom-extra"
      />,
    )
    const root = container.firstElementChild as HTMLElement | null
    expect(root!.className).toContain('custom-extra')
  })
})
