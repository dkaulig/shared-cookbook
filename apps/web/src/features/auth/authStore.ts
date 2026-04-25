import { create } from 'zustand'
import type { AuthUser } from '@shared-cookbook/shared'

/**
 * Auth store — access token in JS memory only, user profile alongside.
 * On page reload the access token is lost and `useSession()` must call
 * `/api/auth/refresh` to rehydrate (refresh cookie survives reload).
 *
 * Spec: PRD §10.7 — "Access-Token nur im JS-Memory … Bei Page-Reload:
 * Silent-Refresh via `/auth/refresh`".
 */
interface AuthState {
  accessToken: string | null
  user: AuthUser | null
  isAuthenticated: boolean
  setSession: (accessToken: string, user: AuthUser) => void
  setAccessToken: (accessToken: string) => void
  clear: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,
  setSession: (accessToken, user) =>
    set({ accessToken, user, isAuthenticated: true }),
  setAccessToken: (accessToken) =>
    set((s) => ({ accessToken, isAuthenticated: s.user !== null })),
  clear: () => set({ accessToken: null, user: null, isAuthenticated: false }),
}))
