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
      <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10 text-center">
        <div className="mx-auto w-full max-w-md">
          <span className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl">
            {/*
              Decorative chef-hat glyph — kept as a Unicode cooking-pot
              so the fallback has zero dependency on the app bundle (it
              renders even if the font-loading step itself threw).
            */}
            <span aria-hidden="true">🍲</span>
          </span>
          <h1 className="mb-3 font-serif text-[clamp(28px,6vw,36px)] font-semibold leading-[1.1] tracking-[-0.015em] text-foreground">
            Ups, da ist etwas schief gelaufen.
          </h1>
          <p className="mb-6 font-serif-body text-[15px] italic leading-[1.55] text-muted-foreground">
            Bitte lade die Seite neu. Sollte das Problem bestehen bleiben, melde dich bei den anderen Gruppen-Admins.
          </p>
          <Button type="button" size="lg" onClick={this.handleReload}>
            Neu laden
          </Button>
        </div>
      </main>
    )
  }
}
