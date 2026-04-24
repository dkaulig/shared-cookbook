import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toastMutationError } from '@/features/_shared/errorSurface'
import { useAcceptInvite, useDeclineInvite, useMyReceivedInvites } from './hooks'

/**
 * DS3-restyled pending-invite banner.
 *
 * Mirrors `.invite-banner` from `docs/mockups/warme-kueche-home.html`:
 * - Cream/white surface with a 3 px amber accent line on the left.
 * - Amber envelope icon in a tinted circle.
 * - Inline Accept / Decline controls.
 * - Multiple invites stack vertically as separate banners so each
 *   decision is its own tidy card (matches the mockup's "stacked" spec).
 *
 * Hides itself while the query is loading or when no invites are
 * pending, exactly like the S2 version — only the visual changed.
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
      className="space-y-2"
    >
      {invites.data.map((invite) => (
        <article
          key={invite.id}
          className={cn(
            'flex items-start gap-3 rounded-[12px] border border-border bg-card p-[14px_16px] shadow-[0_1px_2px_rgba(28,25,23,0.04)]',
            'border-l-[3px] border-l-primary',
          )}
        >
          <span
            aria-hidden="true"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--primary)/0.08)] text-primary"
          >
            <Mail className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="flex-1">
            <p className="text-sm leading-[1.5] text-foreground">
              <strong className="font-semibold">{invite.inviterDisplayName}</strong>{' '}
              lädt dich zu{' '}
              <span className="font-semibold text-primary">„{invite.groupName}"</span>{' '}
              ein.
            </p>
            <div className="mt-[10px] flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  // REL-5 — surface server errors as a toast. The row
                  // stays visible on failure so the user can retry;
                  // otherwise a 500 would look like a phantom success.
                  decline.mutate(invite.id, { onError: toastMutationError })
                }
                disabled={decline.isPending}
              >
                Ablehnen
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  accept.mutate(invite.id, { onError: toastMutationError })
                }
                disabled={accept.isPending}
              >
                Annehmen
              </Button>
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}
