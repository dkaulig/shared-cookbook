import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { AppLayout } from './AppLayout'

function renderAt(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div data-testid="home-child">Home</div>} />
        <Route path="/groups" element={<div data-testid="groups-child">Groups</div>} />
        <Route
          path="/groups/:groupId/recipes/:recipeId"
          element={<div data-testid="recipe-child">Recipe</div>}
        />
        <Route
          path="/groups/:groupId/recipes/:recipeId/edit"
          element={<div data-testid="recipe-edit-child">Edit</div>}
        />
      </Route>
    </Routes>,
    { wrapper: Wrapper },
  )
}

describe('<AppLayout />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'maintainer@example.com',
      displayName: 'David',
      role: 'User',
    })
    server.use(http.get('/api/groups/invites', () => HttpResponse.json([])))
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the routed child via <Outlet />', () => {
    renderAt('/')
    expect(screen.getByTestId('home-child')).toHaveTextContent('Home')
  })

  it('mounts the TopNav (banner + brand lockup)', () => {
    renderAt('/')
    expect(screen.getByRole('banner')).toHaveTextContent('Familien-Kochbuch')
  })

  it('mounts the BottomNav (navigation landmark with all five items)', () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: /hauptnavigation/i })).toBeInTheDocument()
  })

  it('does NOT apply the parchment background (scoped to AuthLayout)', () => {
    const { container } = renderAt('/')
    expect(container.querySelector('.auth-parchment')).toBeNull()
  })

  it('reserves bottom space so content clears the fixed BottomNav', () => {
    const { container } = renderAt('/')
    const main = container.querySelector('main[data-app-shell="true"]')
    expect(main).not.toBeNull()
    // Tailwind utility echoes the mockup's `padding-bottom: 88px + safe-area`.
    expect(main?.className).toMatch(/pb-/)
  })

  it('hides the shared TopNav on the recipe detail route (DS5 owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1')
    // banner = <header role="banner"> in TopNav. Absent on recipe detail.
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-child')).toBeInTheDocument()
  })

  it('keeps the shared TopNav on the recipe edit route', () => {
    renderAt('/groups/g1/recipes/r1/edit')
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByTestId('recipe-edit-child')).toBeInTheDocument()
  })
})
