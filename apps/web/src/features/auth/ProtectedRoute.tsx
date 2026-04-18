import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from './useSession'

/**
 * Wraps app routes that require an authenticated session. During the
 * initial silent-refresh round-trip we render a neutral splash instead
 * of flicker-redirecting to /login.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status } = useSession()

  if (status === 'loading') {
    return (
      <main
        role="status"
        aria-live="polite"
        className="flex min-h-dvh items-center justify-center text-sm text-stone-500"
      >
        Lade …
      </main>
    )
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
