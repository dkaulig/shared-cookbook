import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Pagination } from './pagination'
import { buildPageList } from './pagination-helpers'

describe('<Pagination />', () => {
  it('returns null when there is only one page', () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} onPageChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders numbered buttons for each page when total <= 7', () => {
    render(<Pagination page={1} totalPages={5} onPageChange={() => {}} />)
    for (const n of [1, 2, 3, 4, 5]) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^Seite ${n}$`) }),
      ).toBeInTheDocument()
    }
    // Also exposes prev/next arrows.
    expect(screen.getByRole('button', { name: /Vorherige Seite/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Nächste Seite/ })).toBeInTheDocument()
  })

  it('disables the prev arrow on page 1 and the next arrow on the last page', () => {
    const { rerender } = render(
      <Pagination page={1} totalPages={3} onPageChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /Vorherige Seite/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Nächste Seite/ })).toBeEnabled()

    rerender(<Pagination page={3} totalPages={3} onPageChange={() => {}} />)
    expect(screen.getByRole('button', { name: /Vorherige Seite/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Nächste Seite/ })).toBeDisabled()
  })

  it('fires onPageChange with the clicked page number', async () => {
    const spy = vi.fn()
    render(<Pagination page={1} totalPages={5} onPageChange={spy} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Seite 3/ }))
    expect(spy).toHaveBeenCalledWith(3)
  })

  it('renders the mobile "N / M" summary', () => {
    render(<Pagination page={3} totalPages={12} onPageChange={() => {}} />)
    // The summary text only appears in the `md:hidden` branch, but jsdom
    // keeps it in the DOM — we can still assert it exists.
    expect(screen.getByText('3 / 12')).toBeInTheDocument()
  })

  it('marks the current page with aria-current=page', () => {
    render(<Pagination page={2} totalPages={3} onPageChange={() => {}} />)
    const current = screen.getByRole('button', { name: /Seite 2/ })
    expect(current).toHaveAttribute('aria-current', 'page')
  })

  it('buildPageList returns full range for ≤ 7 pages', () => {
    expect(buildPageList(3, 6)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('buildPageList elides with a leading ellipsis when current is near the end', () => {
    expect(buildPageList(11, 12)).toEqual([1, 'ellipsis', 8, 9, 10, 11, 12])
  })

  it('buildPageList elides on both sides when current is in the middle', () => {
    expect(buildPageList(6, 12)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 12])
  })

  it('buildPageList elides with a trailing ellipsis when current is near the start', () => {
    expect(buildPageList(2, 12)).toEqual([1, 2, 3, 4, 5, 'ellipsis', 12])
  })

  it('paginates correctly for total=12, pageSize=24 (one page → hidden)', () => {
    // total=12 rows / pageSize=24 ⇒ 1 page → Pagination renders null.
    const { container } = render(
      <Pagination page={1} totalPages={1} onPageChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
