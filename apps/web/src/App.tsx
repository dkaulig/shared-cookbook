import { useEffect, useState } from 'react'
import { fetchHealth } from '@/lib/api'

type HealthState = 'loading' | 'connected' | 'error'

export default function App() {
  const [healthState, setHealthState] = useState<HealthState>('loading')

  useEffect(() => {
    const controller = new AbortController()

    fetchHealth(controller.signal)
      .then(() => setHealthState('connected'))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setHealthState('error')
      })

    return () => controller.abort()
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center gap-6 px-6 py-12 text-center">
      <h1 className="text-4xl font-bold tracking-tight text-amber-900 sm:text-5xl">
        Familien-Kochbuch
      </h1>
      <p className="max-w-prose text-base text-stone-700">
        Eine private Rezept-Sammlung für Familie und Freunde.
      </p>
      <HealthBadge state={healthState} />
    </main>
  )
}

function HealthBadge({ state }: { state: HealthState }) {
  const labels: Record<HealthState, string> = {
    loading: 'API-Status wird geprüft …',
    connected: '✓ API verbunden',
    error: '✗ API nicht erreichbar',
  }

  const classes: Record<HealthState, string> = {
    loading: 'bg-stone-100 text-stone-700 ring-stone-300',
    connected: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
    error: 'bg-red-50 text-red-800 ring-red-300',
  }

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="health-badge"
      data-state={state}
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ring-1 ${classes[state]}`}
    >
      {labels[state]}
    </span>
  )
}
