import { Navigate, useParams } from 'react-router-dom'

/**
 * BUG-020 — `/groups/:groupId/tags` is now a permanent redirect into the
 * group settings page (`#tags` anchor). The tag-management UI lives in
 * `<GroupTagsPanel />`, mounted as the last section of
 * `GroupSettingsPage`. The redirect preserves any deep-links people
 * may have bookmarked or pasted into chats.
 */
export function TagManagementPage() {
  const params = useParams<{ groupId: string }>()
  const groupId = params.groupId ?? ''
  if (!groupId) return <Navigate to="/groups" replace />
  return <Navigate to={`/groups/${groupId}/settings#tags`} replace />
}
