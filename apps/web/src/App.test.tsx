import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import App from './App.tsx'
import { server } from './test/msw/server.ts'

describe('<App />', () => {
  it('zeigt die "Familien-Kochbuch" Ueberschrift', () => {
    render(<App />)
    expect(
      screen.getByRole('heading', { level: 1, name: /familien-kochbuch/i }),
    ).toBeInTheDocument()
  })

  it('zeigt "API verbunden" wenn /api/health 200 liefert', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('health-badge')).toHaveAttribute('data-state', 'connected')
    })
    expect(screen.getByTestId('health-badge')).toHaveTextContent(/api verbunden/i)
  })

  it('zeigt "API nicht erreichbar" wenn /api/health fehlschlaegt', async () => {
    server.use(
      http.get('/api/health', () => HttpResponse.text('Service Unavailable', { status: 503 })),
    )

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('health-badge')).toHaveAttribute('data-state', 'error')
    })
    expect(screen.getByTestId('health-badge')).toHaveTextContent(/api nicht erreichbar/i)
  })
})
