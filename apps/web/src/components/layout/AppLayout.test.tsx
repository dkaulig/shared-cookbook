import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { act, render, screen } from '@testing-library/react'
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
        <Route
          path="/groups/:groupId/recipes/new"
          element={<div data-testid="recipe-new-child">New</div>}
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

  it('hides the shared TopNav on the recipe edit route (DS6 form owns its own top bar)', () => {
    renderAt('/groups/g1/recipes/r1/edit')
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-edit-child')).toBeInTheDocument()
  })

  it('hides the shared TopNav on the new-recipe route', () => {
    renderAt('/groups/g1/recipes/new')
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.getByTestId('recipe-new-child')).toBeInTheDocument()
  })

  // ───────── BUG-023 regression ─────────

  describe('--viewport-bottom-offset (BUG-023)', () => {
    type VVListener = (event: Event) => void
    let listeners: Record<string, VVListener[]>
    let originalVV: PropertyDescriptor | undefined
    let originalInnerHeight: number

    beforeEach(() => {
      listeners = { resize: [], scroll: [] }
      const stub = {
        height: 600,
        addEventListener(type: string, fn: VVListener) {
          listeners[type] ??= []
          listeners[type].push(fn)
        },
        removeEventListener(type: string, fn: VVListener) {
          listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn)
        },
      }
      originalVV = Object.getOwnPropertyDescriptor(window, 'visualViewport')
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: stub,
      })
      originalInnerHeight = window.innerHeight
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: 700,
      })
    })

    afterEach(() => {
      if (originalVV) {
        Object.defineProperty(window, 'visualViewport', originalVV)
      } else {
        // jsdom's default — leave the prop undefined as it was on entry.
        Reflect.deleteProperty(window, 'visualViewport')
      }
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      })
      document.documentElement.style.removeProperty('--viewport-bottom-offset')
    })

    it('writes --viewport-bottom-offset = (innerHeight - vv.height) on resize', async () => {
      renderAt('/')
      // Mount-time baseline write.
      expect(
        document.documentElement.style.getPropertyValue('--viewport-bottom-offset'),
      ).toBe('0px')

      // Fire the visualViewport `resize` listener; the effect schedules a
      // RAF, so flush it inside `act` to commit the DOM-style write.
      await act(async () => {
        for (const fn of listeners.resize ?? []) fn(new Event('resize'))
        await new Promise((r) => requestAnimationFrame(() => r(undefined)))
      })

      expect(
        document.documentElement.style.getPropertyValue('--viewport-bottom-offset'),
      ).toBe('100px')
    })
  })

  // ───────── BUG-023 CSS-token guard ─────────

  it('defines --viewport-bottom-offset in index.css (BUG-023 token)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../../index.css'), 'utf8')
    expect(css).toMatch(/--viewport-bottom-offset\s*:/)
  })
})
