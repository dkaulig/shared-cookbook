import { Mail } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
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
 *
 * REL-3g — the invitation sentence is routed through `<Trans>` with
 * two named children (`<strong>` + `<group>`) so the inviter + group
 * name keep their emphasis styling after translation. The children are
 * static span/strong — no user-provided HTML bleeds through.
 */
export function ReceivedInvitesBanner() {
  const { t } = useTranslation()
  const invites = useMyReceivedInvites()
  const accept = useAcceptInvite()
  const decline = useDeclineInvite()

  if (!invites.data || invites.data.length === 0) {
    return null
  }

  return (
    <section
      data-testid="invites-banner"
      aria-label={t('groups.invitesReceived.regionAria')}
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
              <Trans
                i18nKey="groups.invitesReceived.invitationTemplate"
                values={{
                  inviter: invite.inviterDisplayName,
                  group: invite.groupName,
                }}
                components={{
                  strong: <strong className="font-semibold" />,
                  group: <span className="font-semibold text-primary" />,
                }}
              />
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
                {t('groups.invitesReceived.decline')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  accept.mutate(invite.id, { onError: toastMutationError })
                }
                disabled={accept.isPending}
              >
                {t('groups.invitesReceived.accept')}
              </Button>
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}
