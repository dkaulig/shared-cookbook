import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Top-level error boundary. Catches render-time errors in any child and
 * shows a friendly German fallback with a hard-reload button. Mount
 * once around the router so client-side routing exceptions don't strand
 * the user on a blank page.
 *
 * Implemented as a class component because class lifecycle methods
 * (`getDerivedStateFromError` / `componentDidCatch`) are still the only
 * supported error-boundary API in React — no hooks equivalent exists.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to the console for devtools inspection; structured telemetry
    // (Sentry etc.) can hook here later without reshuffling the class.
    console.error('Uncaught render error', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  override render() {
    if (!this.state.hasError) return this.props.children

    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 py-10 text-center">
        <h1 className="mb-3 text-2xl font-bold tracking-tight text-stone-900">
          Ups, da ist etwas schief gelaufen.
        </h1>
        <p className="mb-6 text-stone-600">
          Bitte lade die Seite neu. Sollte das Problem bestehen bleiben, melde dich bei den anderen Gruppen-Admins.
        </p>
        <Button type="button" onClick={this.handleReload}>
          Neu laden
        </Button>
      </main>
    )
  }
}
