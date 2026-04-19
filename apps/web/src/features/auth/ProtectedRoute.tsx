import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useSession } from './useSession'

/**
 * Wraps app routes that require an authenticated session. During the
 * initial silent-refresh round-trip we render a neutral splash instead
 * of flicker-redirecting to /login.
 *
 * PF2 extension: `requireAdmin` gates the route behind the site's
 * Admin role. Non-admin authenticated users bounce to `/` so a
 * bookmark to an admin route doesn't dead-end. Anonymous users still
 * go to `/login` as before.
 */
export function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode
  requireAdmin?: boolean
}) {
  const { status, user } = useSession()

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

  if (requireAdmin && user?.role !== 'Admin') {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
