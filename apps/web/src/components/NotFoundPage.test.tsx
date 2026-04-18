import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { NotFoundPage } from './NotFoundPage'

function renderAt(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<div data-testid="home">home</div>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('<NotFoundPage />', () => {
  it('renders the display "404 · Hier kocht niemand" headline', () => {
    renderAt('/definitely-not-a-route')
    const heading = screen.getByRole('heading', { level: 1, name: /404\s*·\s*hier kocht niemand/i })
    expect(heading).toBeInTheDocument()
    // DS8 Sage Modern: `font-serif` resolves to Inter but we keep the
    // utility opt-in so the headline stays distinguishable from body
    // text via weight + tracking.
    expect(heading.className).toMatch(/font-serif/)
  })

  it('renders the italic serif-body subtitle', () => {
    renderAt('/nope')
    const subtitle = screen.getByText(/diese seite gibt's nicht \(mehr\)\./i)
    expect(subtitle).toBeInTheDocument()
    // DS8 Sage Modern routes italic taglines through the
    // `font-serif-body` utility, which resolves to Inter.
    expect(subtitle.className).toMatch(/italic/)
    expect(subtitle.className).toMatch(/font-serif-body/)
  })

  it('navigates back to the home route when the primary button is clicked', async () => {
    renderAt('/nope')
    expect(screen.queryByTestId('home')).not.toBeInTheDocument()

    const button = screen.getByRole('link', { name: /zur startseite/i })
    expect(button).toHaveAttribute('href', '/')

    await userEvent.click(button)
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })

  it('uses the warm-palette background so the page feels coherent (DS7)', () => {
    renderAt('/nope')
    const heading = screen.getByRole('heading', { level: 1, name: /404/i })
    const main = heading.closest('main')
    expect(main).not.toBeNull()
    expect(main!.className).toMatch(/bg-background/)
  })
})
