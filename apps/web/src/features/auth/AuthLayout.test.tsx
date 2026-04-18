import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AuthLayout } from './AuthLayout'

describe('<AuthLayout />', () => {
  it('renders the routed child via <Outlet />', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<div data-testid="child">HELLO</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('child')).toHaveTextContent('HELLO')
  })

  it('renders the Familien-Kochbuch brand lockup with chef-hat mark', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<div>child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const header = screen.getByRole('banner')
    expect(within(header).getByText('Familien-Kochbuch')).toBeInTheDocument()
    expect(within(header).getByText(/seit immer · für uns alle/i)).toBeInTheDocument()
    // ChefHatLogo renders a real <svg>; the banner should contain one.
    expect(header.querySelector('svg')).not.toBeNull()
  })

  it('shows the privacy footer note', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<div>child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent(/privat & Gruppen-gated/i)
  })

  it('scopes the decorative parchment dotted background to the auth shell', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route element={<AuthLayout />}>
            <Route path="/login" element={<div>child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    // Root wrapper opts into the parchment pattern class. Gate it here
    // so a renderer removing the effect breaks the test.
    const root = container.querySelector('[data-auth-shell="true"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('class')).toMatch(/auth-parchment/)
  })
})
