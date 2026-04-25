import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserSearchResult } from '@shared-cookbook/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { classifyMutationError } from '@/features/_shared/errorSurface'
import { useInviteToGroup, useUserSearch } from './hooks'
import { useDebouncedValue } from './useDebouncedValue'

/**
 * Invites an existing app user into a group. Features a 250ms-debounced
 * search input that queries `/api/users/search?q=…&excludeGroupId=…` —
 * tapping a result submits the invite immediately.
 */
export function InviteMemberDialog({
  groupId,
  onClose,
}: {
  groupId: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [rawQuery, setRawQuery] = useState('')
  const debouncedQuery = useDebouncedValue(rawQuery.trim(), 200)
  const search = useUserSearch(debouncedQuery, groupId)
  const invite = useInviteToGroup(groupId)

  const [error, setError] = useState<string | null>(null)

  async function handlePick(user: UserSearchResult) {
    setError(null)
    try {
      await invite.mutateAsync({ invitedUserId: user.id })
      onClose()
    } catch (err) {
      // REL-3f — localise via errors.json + drop 5xx leaks.
      setError(classifyMutationError(err).message)
    }
  }

  return (
    <div
      role="dialog"
      aria-labelledby="invite-member-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="invite-member-dialog-title" className="mb-4 text-xl font-semibold text-stone-900">
          {t('groups.inviteDialog.title')}
        </h2>

        <div className="space-y-1.5">
          <Label htmlFor="invite-search">
            {t('groups.inviteDialog.searchLabel')}
          </Label>
          <Input
            id="invite-search"
            type="search"
            autoComplete="off"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder={t('groups.inviteDialog.searchPlaceholder')}
          />
        </div>

        <div className="mt-3 min-h-24 max-h-72 overflow-auto rounded-md ring-1 ring-border">
          {debouncedQuery.length === 0 && (
            <p className="px-3 py-2 text-sm text-stone-500">
              {t('groups.inviteDialog.typeToSearch')}
            </p>
          )}
          {debouncedQuery.length > 0 && search.isLoading && (
            <p className="px-3 py-2 text-sm text-stone-500">
              {t('groups.inviteDialog.searching')}
            </p>
          )}
          {debouncedQuery.length > 0 && search.isSuccess && search.data?.length === 0 && (
            <p className="px-3 py-2 text-sm text-stone-500">
              {t('groups.inviteDialog.noResults')}
            </p>
          )}
          {search.isSuccess && search.data?.length > 0 && (
            <ul className="divide-y">
              {search.data.map((user) => (
                <li key={user.id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => handlePick(user)}
                    disabled={invite.isPending}
                  >
                    {user.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
