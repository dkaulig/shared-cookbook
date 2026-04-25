import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiUsageSummary } from '@shared-cookbook/shared'
import { server } from '@/test/msw/server'
import { useAuthStore } from '@/features/auth/authStore'
import { AiUsagePage } from './AiUsagePage'

/**
 * MSW-driven tests for `/admin/ai-usage`. Covers the happy-path
 * render (totals + breakdown rows), the empty-range state, and the
 * groupBy picker updating the query.
 */

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname}</div>
}

function renderPage(initialRoute = '/admin/ai-usage') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialRoute]}>
          <LocationProbe />
          <Routes>
            <Route path="/admin/ai-usage" element={children} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )
  }
  return render(<AiUsagePage />, { wrapper: Wrapper })
}

function seedAdmin() {
  useAuthStore.getState().setSession('tok', {
    id: 'admin-1',
    email: 'admin@test.local',
    displayName: 'Admin',
    role: 'Admin',
  })
}

describe('<AiUsagePage />', () => {
  beforeEach(() => {
    seedAdmin()
  })
  afterEach(() => {
    server.resetHandlers()
    useAuthStore.getState().clear()
  })

  it('renders the headline, period picker, and default totals', async () => {
    server.use(
      http.get('/api/admin/ai-usage', () =>
        HttpResponse.json<AiUsageSummary>({
          totalPromptTokens: 1_500_000,
          totalCompletionTokens: 300_000,
          totalCachedTokens: 200_000,
          totalUsd: 4.0,
          totalEur: 3.68,
          groupBy: 'model',
          groups: [
            {
              key: 'gpt-5.1-chat',
              promptTokens: 1_000_000,
              completionTokens: 200_000,
              cachedTokens: 100_000,
              usd: 3.0,
              eur: 2.76,
            },
            {
              key: 'gpt-4.1-mini',
              promptTokens: 500_000,
              completionTokens: 100_000,
              cachedTokens: 100_000,
              usd: 1.0,
              eur: 0.92,
            },
          ],
        }),
      ),
    )

    renderPage()

    expect(
      screen.getByRole('heading', { name: /KI-Verbrauch/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Letzte 30 Tage/i)).toBeInTheDocument()

    // Wait for the data to land + totals render.
    await waitFor(() =>
      expect(screen.getByText(/1\.500\.000/)).toBeInTheDocument(),
    )
    // Completion total (300,000) and one cached (200,000) appear in totals.
    expect(screen.getByText(/300\.000/)).toBeInTheDocument()
    // EUR total is 3.68 — rendered via Intl de-DE currency format.
    expect(screen.getByText(/3,68/)).toBeInTheDocument()

    // Breakdown table has both rows.
    const table = screen.getByRole('table')
    const cells = within(table).getAllByRole('cell')
    expect(cells.some((c) => c.textContent === 'gpt-5.1-chat')).toBe(true)
    expect(cells.some((c) => c.textContent === 'gpt-4.1-mini')).toBe(true)
  })

  it('renders the empty-state copy when the server returns no groups', async () => {
    server.use(
      http.get('/api/admin/ai-usage', () =>
        HttpResponse.json<AiUsageSummary>({
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCachedTokens: 0,
          totalUsd: 0,
          totalEur: 0,
          groupBy: 'model',
          groups: [],
        }),
      ),
    )

    renderPage()

    await waitFor(() =>
      expect(
        screen.getByText(/Keine Verbrauchsdaten im gewählten Zeitraum\./i),
      ).toBeInTheDocument(),
    )
  })

  it('shows an error banner when the server returns a non-2xx response', async () => {
    server.use(
      http.get(
        '/api/admin/ai-usage',
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
    renderPage()
    await waitFor(() =>
      expect(
        screen.getByText(/Verbrauchsdaten konnten nicht geladen werden\./i),
      ).toBeInTheDocument(),
    )
  })

  it('switches groupBy when the Nutzer:in button is clicked and re-fetches', async () => {
    const received: string[] = []
    server.use(
      http.get('/api/admin/ai-usage', ({ request }) => {
        const url = new URL(request.url)
        received.push(url.searchParams.get('groupBy') ?? 'model')
        return HttpResponse.json<AiUsageSummary>({
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCachedTokens: 0,
          totalUsd: 0,
          totalEur: 0,
          groupBy: (url.searchParams.get('groupBy') ?? 'model') as AiUsageSummary['groupBy'],
          groups: [],
        })
      }),
    )
    renderPage()
    await waitFor(() => expect(received).toContain('model'))

    const userBtn = screen.getByRole('button', { name: /Nutzer:in/i })
    await userEvent.click(userBtn)

    await waitFor(() => expect(received).toContain('user'))
  })

  it('passes custom from + to when the user picks benutzerdefiniert + a range', async () => {
    const seen: Array<{ from: string | null; to: string | null }> = []
    server.use(
      http.get('/api/admin/ai-usage', ({ request }) => {
        const url = new URL(request.url)
        seen.push({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        })
        return HttpResponse.json<AiUsageSummary>({
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCachedTokens: 0,
          totalUsd: 0,
          totalEur: 0,
          groupBy: 'model',
          groups: [],
        })
      }),
    )
    renderPage()
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))

    const customBtn = screen.getByRole('button', { name: /Benutzerdefiniert/i })
    await userEvent.click(customBtn)
    const from = screen.getByLabelText(/^Von$/i)
    const to = screen.getByLabelText(/^Bis$/i)
    await userEvent.type(from, '2026-03-01')
    await userEvent.type(to, '2026-04-01')

    // The last request after both inputs filled should carry both.
    await waitFor(() => {
      const last = seen[seen.length - 1]
      expect(last.from).toContain('2026-03-01')
      expect(last.to).toContain('2026-04-01')
    })
  })
})
