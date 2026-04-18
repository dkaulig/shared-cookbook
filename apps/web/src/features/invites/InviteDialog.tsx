import { useState } from 'react'
import type { CreateInviteResponse } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/features/auth/apiClient'

/**
 * Simple dialog for creating an app-level invite. Shown from the home
 * page's "Jemanden einladen" button. Keeps markup framework-light —
 * swap in a real Dialog primitive when we pull Radix Dialog into shadcn.
 */
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const [invite, setInvite] = useState<CreateInviteResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleCreate() {
    setSubmitting(true)
    setError(null)
    try {
      const response = await apiClient('/api/invites/app/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!response.ok) {
        setError('Einladung konnte nicht erstellt werden.')
        return
      }
      setInvite((await response.json()) as CreateInviteResponse)
    } catch {
      setError('Einladung konnte nicht erstellt werden.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCopy() {
    if (!invite) return
    await navigator.clipboard.writeText(invite.inviteUrl)
    setCopied(true)
  }

  return (
    <div
      role="dialog"
      aria-labelledby="invite-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="invite-dialog-title" className="mb-4 text-xl font-semibold text-stone-900">
          Jemanden einladen
        </h2>

        {!invite ? (
          <div className="space-y-4">
            <p className="text-sm text-stone-700">
              Klicke auf „Einladung erstellen&quot;, um einen einmaligen Einladungs-Link zu generieren.
            </p>

            {error && (
              <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="button" onClick={handleCreate} disabled={submitting}>
                Einladung erstellen
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-stone-700">
              Teile diesen Link — er ist 14 Tage gültig und einmalig verwendbar:
            </p>
            <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs text-stone-800">
              {invite.inviteUrl}
            </code>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Schließen
              </Button>
              <Button type="button" onClick={handleCopy}>
                {copied ? 'Kopiert!' : 'Link kopieren'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
