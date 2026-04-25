import { useQuery } from '@tanstack/react-query'
import type { GroupSummary } from '@shared-cookbook/shared'
import { fetchMyGroups } from './groupsApi'
import { groupQueryKeys } from './queryKeys'

/**
 * Reads the signed-in user's groups (including their Private Sammlung).
 * Cache key: `['groups', 'mine']`. All group mutations invalidate this.
 */
export function useMyGroups() {
  return useQuery<GroupSummary[]>({
    queryKey: groupQueryKeys.mine(),
    queryFn: fetchMyGroups,
  })
}
