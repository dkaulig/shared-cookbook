/**
 * Centralised TanStack Query cache keys. Feature hooks use these factory
 * functions so invalidations stay consistent (e.g. mutations invalidating
 * `['groups', 'mine']` reach every component reading the list).
 */
export const groupQueryKeys = {
  all: ['groups'] as const,
  mine: () => [...groupQueryKeys.all, 'mine'] as const,
  detail: (id: string) => [...groupQueryKeys.all, 'detail', id] as const,
  members: (id: string) => [...groupQueryKeys.all, 'members', id] as const,
  invitesReceived: () => ['groups', 'invites', 'received'] as const,
  userSearch: (q: string, excludeGroupId?: string) =>
    ['users', 'search', q, excludeGroupId ?? 'none'] as const,
}
