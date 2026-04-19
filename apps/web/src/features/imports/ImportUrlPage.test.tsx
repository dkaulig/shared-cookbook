import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { GroupSummary } from '@familien-kochbuch/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { ImportUrlPage } from './ImportUrlPage'

function groupSummary(over: Partial<GroupSummary>): GroupSummary {
  return {
    id: 'g1',
    name: 'Familie',
    description: null,
    coverImageUrl: null,
    defaultServings: 4,
    isPrivateCollection: false,
    memberCount: 4,
    myRole: 'Admin',
    ...over,
  }
}

/**
 * Probe component that surfaces the current pathname so tests can assert
 * navigation without coupling to react-router internals.
 */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/rezepte/import/url']}>
          <LocationProbe />
          <Routes>
            <Route path="/rezepte/import/url" element={children} />
            <Route
              path="/rezepte/import/:importId"
              element={<div data-testid="progress-page">progress</div>}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<ImportUrlPage />, { wrapper: Wrapper })
}

describe('<ImportUrlPage />', () => {
  beforeEach(() => {
    useAuthStore.getState().setSession('tok', {
      id: 'u1',
      email: 'u1@ex.com',
      displayName: 'U',
      role: 'User',
    })
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the headline, url field (autofocused), and submit button', async () => {
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
    )
    renderPage()
    expect(
      screen.getByRole('heading', { name: /Rezept aus Video importieren/i }),
    ).toBeInTheDocument()
    const input = screen.getByLabelText(/Video- oder Blog-URL/i)
    expect(input).toBeInTheDocument()
    // jsdom respects autoFocus via the ref effect — assert the focus
    // landed on the URL input.
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(
      screen.getByRole('button', { name: /Rezept importieren/i }),
    ).toBeDisabled()
  })

  it('rejects a non-http scheme with a German error and no API call', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({})]),
      ),
      http.post('/api/recipes/import/url', () => {
        posted = true
        return HttpResponse.json({ importId: 'x' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(screen.getByLabelText(/Video- oder Blog-URL/i), 'ftp://example.com/x')
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /muss absolut sein und mit http/i,
    )
    expect(posted).toBe(false)
  })

  it('with 1 group: skips picker, POSTs with that groupId, navigates to the progress route', async () => {
    const user = userEvent.setup()
    let capturedBody: { url: string; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'only', isPrivateCollection: true, memberCount: 1 }),
        ]),
      ),
      http.post('/api/recipes/import/url', async ({ request }) => {
        capturedBody = (await request.json()) as { url: string; groupId: string }
        return HttpResponse.json({ importId: 'imp-42' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody!.groupId).toBe('only')
    expect(capturedBody!.url).toBe('https://example.com/r')
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/imp-42'),
    )
  })

  it('with >1 groups: opens the GroupPickerDialog, POSTs with the picked group on selection', async () => {
    const user = userEvent.setup()
    let capturedBody: { url: string; groupId: string } | null = null
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([
          groupSummary({ id: 'ga', name: 'Alpha' }),
          groupSummary({ id: 'gb', name: 'Beta' }),
        ]),
      ),
      http.post('/api/recipes/import/url', async ({ request }) => {
        capturedBody = (await request.json()) as { url: string; groupId: string }
        return HttpResponse.json({ importId: 'imp-77' }, { status: 202 })
      }),
    )
    renderPage()
    // Wait for groups so the branch is correct when submit fires.
    await screen.findByRole('heading', { name: /Rezept aus Video importieren/i })

    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))

    // The picker dialog opens.
    const pickerHeading = await screen.findByText(/in welcher gruppe/i)
    expect(pickerHeading).toBeInTheDocument()
    // Pick Beta.
    await user.click(screen.getByRole('button', { name: /Beta/ }))

    await waitFor(() => expect(capturedBody).not.toBeNull())
    expect(capturedBody!.groupId).toBe('gb')
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/imp-77'),
    )
  })

  it('with 0 groups: offers CreateGroupDialog and does NOT POST', async () => {
    const user = userEvent.setup()
    let posted = false
    server.use(
      http.get('/api/groups', () => HttpResponse.json<GroupSummary[]>([])),
      http.post('/api/recipes/import/url', () => {
        posted = true
        return HttpResponse.json({ importId: 'x' }, { status: 202 })
      }),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    expect(await screen.findByText(/Gruppe erstellen/i)).toBeInTheDocument()
    expect(posted).toBe(false)
  })

  it('surfaces a server 400 error inline (no navigation)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/groups', () =>
        HttpResponse.json<GroupSummary[]>([groupSummary({ id: 'only' })]),
      ),
      http.post('/api/recipes/import/url', () =>
        HttpResponse.json(
          { code: 'invalid_url', message: 'Die URL ist nicht erlaubt.' },
          { status: 400 },
        ),
      ),
    )
    renderPage()
    await user.type(
      screen.getByLabelText(/Video- oder Blog-URL/i),
      'https://example.com/r',
    )
    await user.click(screen.getByRole('button', { name: /Rezept importieren/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/nicht erlaubt/i)
    expect(screen.getByTestId('location')).toHaveTextContent('/rezepte/import/url')
  })
})
