import { Button } from '@/components/ui/button'
import { useAcceptInvite, useDeclineInvite, useMyReceivedInvites } from './hooks'

/**
 * Compact banner that lists pending group invites for the signed-in
 * user. Shown at the top of any protected page; hides itself while the
 * query is loading or when no invites are pending.
 */
export function ReceivedInvitesBanner() {
  const invites = useMyReceivedInvites()
  const accept = useAcceptInvite()
  const decline = useDeclineInvite()

  if (!invites.data || invites.data.length === 0) {
    return null
  }

  return (
    <section
      data-testid="invites-banner"
      aria-label="Offene Gruppen-Einladungen"
      className="mx-auto mb-4 w-full max-w-3xl rounded-md bg-amber-50 p-4 ring-1 ring-amber-200"
    >
      <h2 className="mb-2 text-sm font-semibold text-amber-900">Neue Einladungen</h2>
      <ul className="space-y-2">
        {invites.data.map((invite) => (
          <li
            key={invite.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-background px-3 py-2 text-sm ring-1 ring-border"
          >
            <div className="text-stone-800">
              <strong>{invite.inviterDisplayName}</strong> hat dich in die Gruppe{' '}
              <strong>{invite.groupName}</strong> eingeladen.
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => accept.mutate(invite.id)}
                disabled={accept.isPending}
              >
                Annehmen
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => decline.mutate(invite.id)}
                disabled={decline.isPending}
              >
                Ablehnen
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
