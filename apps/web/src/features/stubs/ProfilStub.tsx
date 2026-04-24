import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'
import { Mail, Pencil, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LanguageToggle } from '@/components/layout/LanguageToggle'
import { useAuth } from '@/features/auth/useAuth'
import { useAuthStore } from '@/features/auth/authStore'
import { changeDisplayName, changePassword } from '@/features/auth/accountClient'
import { InviteDialog } from '@/features/invites/InviteDialog'
import { classifyMutationError } from '@/features/_shared/errorSurface'

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
 *
 * REL-3g — copy routed through `t('account.profilePage.*')` so the
 * surface flips locale cleanly. The `<Trans>` block for the display-
 * name inline read-out uses a single `<name>` child so the `<span>`
 * styling survives translation without eval'ing arbitrary HTML.
 */
export function ProfilStub() {
  const { t } = useTranslation()
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
        {t('account.profilePage.heading')}
      </h1>
      <DisplayNameLine
        currentName={user?.displayName ?? ''}
        onSaved={(next) => {
          if (accessToken) setSession(accessToken, next)
        }}
      />

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>{t('account.profilePage.accountHeading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate text-foreground">
              {user?.email ?? '…'}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.profilePage.moreSettingsSoon')}
          </p>
        </CardContent>
      </Card>

      <PasswordCard />

      {/* REL-3h — language switcher lives here, not in TopNav. Casual
          users don't stumble onto it mid-navigation; enthusiasts find
          it under /profil next to the other account controls. */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle>{t('account.profilePage.language.heading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('account.profilePage.language.description')}
          </p>
          <LanguageToggle />
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>{t('account.profilePage.inviteHeading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-foreground">
            {t('account.profilePage.inviteBody')}
          </p>
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('account.profilePage.inviteCta')}
          </Button>
        </CardContent>
      </Card>

      {user?.role === 'Admin' && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>{t('account.profilePage.adminHeading')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('account.profilePage.adminAiUsageBody')}
            </p>
            <Button asChild variant="outline">
              <Link to="/admin/ai-usage">
                {t('account.profilePage.adminAiUsageCta')}
              </Link>
            </Button>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('account.profilePage.adminExtractorBody')}
            </p>
            <Button asChild variant="outline">
              <Link to="/admin/extractor">
                {t('account.profilePage.adminExtractorCta')}
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>{t('account.profilePage.logoutHeading')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('account.profilePage.logoutBody')}
          </p>
          <Button type="button" variant="outline" onClick={handleLogout}>
            {t('account.profilePage.logoutCta')}
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
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(currentName)
  // REL-5d — inline field-error state. `null` = no error; otherwise
  // `{ fieldName, message }`. `fieldName` is a machine identifier used
  // only as a Map-key for focus routing — never rendered verbatim.
  const [fieldError, setFieldError] = useState<
    { fieldName: string | null; message: string } | null
  >(null)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const trimmed = draft.trim()
  const validLength = trimmed.length >= DISPLAYNAME_MIN && trimmed.length <= DISPLAYNAME_MAX
  const canSave = validLength && trimmed !== currentName && !saving

  function enterEdit() {
    setDraft(currentName)
    setFieldError(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setFieldError(null)
  }

  async function save() {
    if (!canSave) return
    setSaving(true)
    setFieldError(null)
    try {
      const next = await changeDisplayName({ displayName: trimmed })
      onSaved(next)
      setEditing(false)
    } catch (err) {
      // REL-5d — route via the REL-5 classifier so the rendered copy
      // comes from the `errors:*` i18n namespace (keyed by backend
      // code), not the server-supplied English `message` text.
      const classified = classifyMutationError(err)
      const next = {
        fieldName: classified.fieldName ?? null,
        message: classified.message,
      }
      setFieldError(next)
      // Only focus the input when the backend attributed the failure
      // to the `displayName` field specifically (REL-4 fieldName).
      // Other errors (network / generic) keep the inline banner but
      // leave focus wherever the user put it.
      if (classified.fieldName === 'displayName') {
        inputRef.current?.focus()
      }
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <p className="mt-2 font-serif-body text-[15px] italic leading-[1.5] text-muted-foreground">
        <Trans
          i18nKey="account.profilePage.signedInAsTemplate"
          values={{ name: currentName || '…' }}
          components={{
            name: <span className="not-italic font-semibold text-foreground" />,
          }}
        />
        <button
          type="button"
          onClick={enterEdit}
          aria-label={t('account.profilePage.editDisplayNameAria')}
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
        {t('account.profilePage.displayNameLabel')}
      </Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Input
          id="displayname-input"
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={DISPLAYNAME_MAX + 20}
          autoFocus
          className="sm:max-w-xs"
          aria-invalid={fieldError?.fieldName === 'displayName' || undefined}
          aria-describedby={
            fieldError?.fieldName === 'displayName' ? 'displayname-error' : undefined
          }
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!canSave}>
            {t('account.profilePage.saveCta')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={cancel} disabled={saving}>
            {t('account.profilePage.cancelCta')}
          </Button>
        </div>
      </div>
      {!validLength && (
        <p className="text-xs text-muted-foreground">
          {t('account.profilePage.displayNameHintTemplate', {
            min: DISPLAYNAME_MIN,
            max: DISPLAYNAME_MAX,
          })}
        </p>
      )}
      {fieldError && (
        <p
          id={fieldError.fieldName === 'displayName' ? 'displayname-error' : undefined}
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          {fieldError.message}
        </p>
      )}
    </form>
  )
}

// ── Passwort ändern ────────────────────────────────────────────────

function PasswordCard() {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  // REL-5d — `fieldError` replaces the prior `error` string. `fieldName`
  // is null for errors the backend did not attribute to a specific
  // input (network / 401 / 5xx); those still render as an inline banner
  // at the bottom of the form but do NOT move focus.
  const [fieldError, setFieldError] = useState<
    { fieldName: string | null; message: string } | null
  >(null)
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Ref-map for REL-5d focus routing. Keys are the backend-emitted
  // `fieldName` values (see apps/api/.../AccountEndpoints.cs). Kept as
  // an object rather than a switch so adding a field stays a one-liner
  // on both sides.
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const allFilled = current.length > 0 && next.length > 0 && confirm.length > 0
  const matches = next === confirm
  const differsFromCurrent = next !== current
  const canSubmit = allFilled && matches && differsFromCurrent && !submitting

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!canSubmit) return
    setFieldError(null)
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
      // REL-5d — classify routes the raw backend error through the
      // i18n `errors:<code>` namespace (REL-3). The message we render
      // is the translated German copy, never the server's English
      // dev-message. `fieldName` is a machine identifier, only used
      // as a Map-key to focus the matching input.
      const classified = classifyMutationError(err)
      setFieldError({
        fieldName: classified.fieldName ?? null,
        message: classified.message,
      })
      const target = classified.fieldName
        ? fieldRefs.current[classified.fieldName]
        : null
      target?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle>{t('account.profilePage.passwordHeading')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">
              {t('account.profilePage.passwordCurrent')}
            </Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setSuccess(false)
                setFieldError(null)
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">
              {t('account.profilePage.passwordNew')}
            </Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => {
                setNext(e.target.value)
                setSuccess(false)
                setFieldError(null)
              }}
              ref={(el) => {
                fieldRefs.current.newPassword = el
              }}
              aria-invalid={fieldError?.fieldName === 'newPassword' || undefined}
              aria-describedby={
                fieldError?.fieldName === 'newPassword'
                  ? 'new-password-error'
                  : undefined
              }
            />
            {fieldError?.fieldName === 'newPassword' && (
              <p
                id="new-password-error"
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {fieldError.message}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password-confirm">
              {t('account.profilePage.passwordConfirm')}
            </Label>
            <Input
              id="new-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
                setSuccess(false)
                setFieldError(null)
              }}
              ref={(el) => {
                fieldRefs.current.newPasswordConfirm = el
              }}
              aria-invalid={
                fieldError?.fieldName === 'newPasswordConfirm' || undefined
              }
              aria-describedby={
                fieldError?.fieldName === 'newPasswordConfirm'
                  ? 'new-password-confirm-error'
                  : undefined
              }
            />
            {fieldError?.fieldName === 'newPasswordConfirm' && (
              <p
                id="new-password-confirm-error"
                role="alert"
                className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
              >
                {fieldError.message}
              </p>
            )}
          </div>

          {allFilled && !matches && (
            <p className="text-xs text-muted-foreground">
              {t('account.profilePage.passwordMismatch')}
            </p>
          )}
          {allFilled && matches && !differsFromCurrent && (
            <p className="text-xs text-muted-foreground">
              {t('account.profilePage.passwordSameAsCurrent')}
            </p>
          )}

          {success && (
            <p
              role="status"
              className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200"
            >
              {t('account.profilePage.passwordUpdated')}
            </p>
          )}
          {fieldError && fieldError.fieldName === null && (
            // Fallback banner — server returned an error the classifier
            // did NOT attribute to a specific field (network / 401 /
            // 5xx). Keeps the surface behaviour identical to pre-REL-5d.
            <p
              role="alert"
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
            >
              {fieldError.message}
            </p>
          )}

          <Button type="submit" disabled={!canSubmit} className="self-start">
            {t('account.profilePage.passwordSaveCta')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
