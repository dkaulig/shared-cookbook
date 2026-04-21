import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mail, Pencil, UserPlus } from 'lucide-react'
import type { ApiError } from '@familien-kochbuch/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/features/auth/useAuth'
import { useAuthStore } from '@/features/auth/authStore'
import { changeDisplayName, changePassword } from '@/features/auth/accountClient'
import { InviteDialog } from '@/features/invites/InviteDialog'

const DISPLAYNAME_MIN = 2
const DISPLAYNAME_MAX = 50

/**
 * /profil — the logged-in user's self-service surface.
 *
 * DS7 seeded this as a minimal stub (email + displayname readout,
 * "Jemanden einladen", Abmelden). AP1 extends it with two real
 * operations that previously required an out-of-app password-reset
 * detour: inline displayname edit and a Passwort-ändern card. Both
 * go through `accountClient` → `apiClient`, so the silent-refresh
 * and bearer-token wiring comes for free.
 */
export function ProfilStub() {
  const { user, accessToken, logout } = useAuth()
  const setSession = useAuthStore((s) => s.setSession)
  const navigate = useNavigate()
  const [inviteOpen, setInviteOpen] = useState(false)

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <section className="mx-auto w-full max-w-2xl px-5 py-10 md:px-8 md:py-14">
      <h1 className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]">
        Mein Profil
      </h1>
      <DisplayNameLine
        currentName={user?.displayName ?? ''}
        onSaved={(next) => {
          if (accessToken) setSession(accessToken, next)
        }}
      />

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Konto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground">
              {user?.email ?? '…'}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Weitere Einstellungen folgen in einer späteren Version.
          </p>
        </CardContent>
      </Card>

      <PasswordCard />

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Familie erweitern</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-foreground">
            Hol jemanden in die App. Einladungs-Links sind 14 Tage gültig und einmalig verwendbar.
          </p>
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
            Jemanden einladen
          </Button>
        </CardContent>
      </Card>

      {user?.role === 'Admin' && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Administration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sieh, wieviel die KI-Funktionen bisher gekostet haben.
            </p>
            <Button asChild variant="outline">
              <Link to="/admin/ai-usage">KI-Verbrauch einsehen</Link>
            </Button>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Passe Prompts, Modelle, Feature-Flags und Pipeline-Schwellenwerte live an — Änderungen wirken nach spätestens 60 Sekunden.
            </p>
            <Button asChild variant="outline">
              <Link to="/admin/extractor">Extractor-Konfiguration</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Abmelden</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Melde dich ab, wenn du die App auf einem fremden Gerät benutzt hast.
          </p>
          <Button type="button" variant="outline" onClick={handleLogout}>
            Abmelden
          </Button>
        </CardContent>
      </Card>

      {inviteOpen && <InviteDialog onClose={() => setInviteOpen(false)} />}
    </section>
  )
}

// ── Displayname inline-edit ────────────────────────────────────────

interface DisplayNameLineProps {
  currentName: string
  onSaved: (next: import('@familien-kochbuch/shared').AuthUser) => void
}

function DisplayNameLine({ currentName, onSaved }: DisplayNameLineProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentName)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const trimmed = draft.trim()
  const validLength = trimmed.length >= DISPLAYNAME_MIN && trimmed.length <= DISPLAYNAME_MAX
  const canSave = validLength && trimmed !== currentName && !saving

  function enterEdit() {
    setDraft(currentName)
    setError(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setError(null)
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const next = await changeDisplayName({ displayName: trimmed })
      onSaved(next)
      setEditing(false)
    } catch (err) {
      const apiErr = err as Partial<ApiError>
      setError(apiErr.message ?? 'Anzeigename konnte nicht gespeichert werden.')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-muted-foreground">
        Angemeldet als{' '}
        <span className="not-italic font-semibold text-foreground">
          {currentName || '…'}
        </span>
        .
        <button
          type="button"
          onClick={enterEdit}
          aria-label="Anzeigenamen bearbeiten"
          className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </button>
      </p>
    )
  }

  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      noValidate
    >
      <Label htmlFor="displayname-input" className="text-sm">
        Anzeigename
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Input
          id="displayname-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={DISPLAYNAME_MAX + 20}
          autoFocus
          className="sm:max-w-xs"
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!canSave}>
            Speichern
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={cancel} disabled={saving}>
            Abbrechen
          </Button>
        </div>
      </div>
      {!validLength && (
        <p className="text-xs text-muted-foreground">
          Anzeigename muss zwischen {DISPLAYNAME_MIN} und {DISPLAYNAME_MAX} Zeichen lang sein.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {error}
        </p>
      )}
    </form>
  )
}

// ── Passwort ändern ────────────────────────────────────────────────

function PasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const allFilled = current.length > 0 && next.length > 0 && confirm.length > 0
  const matches = next === confirm
  const differsFromCurrent = next !== current
  const canSubmit = allFilled && matches && differsFromCurrent && !submitting

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return
    setError(null)
    setSuccess(false)
    setSubmitting(true)
    try {
      await changePassword({
        currentPassword: current,
        newPassword: next,
        newPasswordConfirm: confirm,
      })
      setSuccess(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (err) {
      const apiErr = err as Partial<ApiError>
      setError(apiErr.message ?? 'Passwort konnte nicht geändert werden.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>Passwort ändern</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Aktuelles Passwort</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setSuccess(false)
                setError(null)
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">Neues Passwort</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value)
                setSuccess(false)
                setError(null)
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password-confirm">Neues Passwort bestätigen</Label>
            <Input
              id="new-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                setSuccess(false)
                setError(null)
              }}
            />
          </div>

          {allFilled && !matches && (
            <p className="text-xs text-muted-foreground">
              Neues Passwort und Bestätigung stimmen nicht überein.
            </p>
          )}
          {allFilled && matches && !differsFromCurrent && (
            <p className="text-xs text-muted-foreground">
              Das neue Passwort muss sich vom aktuellen unterscheiden.
            </p>
          )}

          {success && (
            <p
              role="status"
              className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200"
            >
              Passwort aktualisiert.
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {error}
            </p>
          )}

          <Button type="submit" disabled={!canSubmit} className="self-start">
            Passwort ändern
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
