import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ApiError,
  ExtractorConfigItem,
  ExtractorConfigListResponse,
} from '@familien-kochbuch/shared'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  fetchExtractorConfigList,
  resetExtractorConfig,
  updateExtractorConfig,
} from './extractorConfigApi'

/**
 * CFG-2 — admin-only page at `/admin/extractor`.
 *
 * One single form split into four sections by `<h2>` headings. State
 * is tracked per-key in local `drafts`; the "Speichern"-button per
 * section iterates the section's keys, diffs each against the
 * server-known baseline, and fires a `PUT` for every changed key with
 * its local `expectedVersion`. The baseline is the last server-known
 * state — on save-success we fold the post-update item back in so a
 * subsequent save uses the fresh version; on 409 we refetch the whole
 * list (the simplest way to reconcile without fighting React-Query's
 * cache key discipline).
 *
 * Feature-flags save immediately on toggle (no section button for
 * that row — a switch flip is its own intent) to keep the boolean
 * UX obvious. Everything else waits for the section Save button so
 * typing one digit at a time doesn't fire a PUT per keystroke.
 */

// ── Key registry ────────────────────────────────────────────────────

const PROMPT_KEYS = [
  'llm.structured.system_prompt',
  'llm.chat.system_prompt',
  'llm.vision.system_prompt',
] as const

const MODEL_KEYS = [
  // Structured
  'llm.structured.deployment',
  'llm.structured.temperature',
  'llm.structured.max_completion_tokens',
  // Chat (no temperature — model rejects non-default)
  'llm.chat.deployment',
  'llm.chat.max_completion_tokens',
  // Vision
  'llm.vision.deployment',
  'llm.vision.temperature',
  'llm.vision.max_completion_tokens',
] as const

const FLAG_KEYS = [
  'feature.video_import_enabled',
  'feature.blog_follow_enabled',
  'feature.nutrition_estimate_enabled',
  'feature.thumbnail_auto_attach_enabled',
  'feature.chat_enabled',
] as const

const FLAG_LABELS: Record<(typeof FLAG_KEYS)[number], string> = {
  'feature.video_import_enabled': 'Aktivieren des Video-Imports',
  'feature.blog_follow_enabled': 'Blog-URL automatisch folgen',
  'feature.nutrition_estimate_enabled': 'Nährwert-Schätzung aktivieren',
  'feature.thumbnail_auto_attach_enabled':
    'Thumbnail automatisch anhängen',
  'feature.chat_enabled': 'Chat-Funktion aktivieren',
}

const THRESHOLD_NUMBER_KEYS = [
  'pipeline.min_transcript_chars',
  'pipeline.component_label_max',
  'pipeline.shortener_max_redirects',
  'pipeline.shortener_head_timeout_seconds',
] as const

const THRESHOLD_LIST_KEYS = [
  'pipeline.shortener_hosts',
  'pipeline.generic_label_blacklist',
] as const

// ── Types ───────────────────────────────────────────────────────────

type DraftMap = Record<string, unknown>
type SavedAtMap = Record<string, number>
type FieldErrorMap = Record<string, string>
type BaselineMap = Record<string, ExtractorConfigItem>

type SectionKey = 'prompts' | 'models' | 'flags' | 'thresholds'

// ── Page ────────────────────────────────────────────────────────────

const LIST_QUERY_KEY = ['admin-extractor-config'] as const

export function ExtractorConfigPage() {
  const queryClient = useQueryClient()
  const listQuery = useQuery<ExtractorConfigListResponse>({
    queryKey: LIST_QUERY_KEY,
    queryFn: fetchExtractorConfigList,
  })

  // Baseline = what the server last told us (used for `expectedVersion`
  // + for "did the user change this?" diffing).
  const baseline = useMemo<BaselineMap>(() => {
    const m: BaselineMap = {}
    for (const it of listQuery.data?.items ?? []) m[it.key] = it
    return m
  }, [listQuery.data])

  const [drafts, setDrafts] = useState<DraftMap>({})
  const [savedAt, setSavedAt] = useState<SavedAtMap>({})
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({})
  const [conflictBanner, setConflictBanner] = useState<string | null>(null)

  // On first successful load (or after a refetch following a 409),
  // seed `drafts` from the server values so every input is controlled
  // from the start and the diff comparison has something sensible.
  const seededRef = useRef<string>('')
  useEffect(() => {
    if (!listQuery.data) return
    // Use the max version across items as a cheap "snapshot identity"
    // — after a 409 + refetch the versions bump, so we can detect "we
    // just received a fresh baseline" and re-seed the drafts.
    const stamp = listQuery.data.items
      .map((i) => `${i.key}:${i.version}`)
      .join('|')
    if (seededRef.current === stamp) return
    seededRef.current = stamp
    const next: DraftMap = {}
    for (const it of listQuery.data.items) next[it.key] = it.value
    setDrafts(next)
    setFieldErrors({})
  }, [listQuery.data])

  const setDraft = useCallback((key: string, value: unknown) => {
    setDrafts((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const markSaved = useCallback(
    (item: ExtractorConfigItem) => {
      setSavedAt((prev) => ({ ...prev, [item.key]: Date.now() }))
      // Fold the fresh item into the baseline by mutating the cached
      // query data — `setQueryData` would be cleaner but the list is
      // small and the refetch on 409 already covers the corrective
      // path. Here we just bump the draft to the server-normalised
      // value so subsequent diffs see "clean".
      setDrafts((prev) => ({ ...prev, [item.key]: item.value }))
    },
    [],
  )

  async function saveKey(key: string, value: unknown): Promise<void> {
    const base = baseline[key]
    if (!base) return
    try {
      const updated = await updateExtractorConfig(key, {
        value,
        expectedVersion: base.version,
      })
      patchCache(queryClient, updated)
      markSaved(updated)
      setConflictBanner(null)
    } catch (err) {
      const apiErr = err as Partial<ApiError>
      if (apiErr.code === 'version_mismatch') {
        setConflictBanner(
          'Ein anderer Admin hat gerade geändert — neu geladen.',
        )
        await listQuery.refetch()
        return
      }
      if (apiErr.code === 'invalid_value') {
        setFieldErrors((prev) => ({
          ...prev,
          [key]: apiErr.message ?? 'Ungültiger Wert.',
        }))
        return
      }
      setFieldErrors((prev) => ({
        ...prev,
        [key]:
          apiErr.message ?? 'Speichern fehlgeschlagen. Bitte erneut versuchen.',
      }))
    }
  }

  async function saveSection(section: SectionKey): Promise<void> {
    setConflictBanner(null)
    const keys = keysForSection(section)
    for (const key of keys) {
      const base = baseline[key]
      if (!base) continue
      const draft = drafts[key]
      if (valuesEqual(draft, base.value)) continue
      // Serial saves intentionally avoid a thundering-herd of PUTs
      // for one-key-per-row diffs and keep the 409 handling linear.
      await saveKey(key, draft)
    }
  }

  async function resetKey(key: string): Promise<void> {
    try {
      const updated = await resetExtractorConfig(key)
      patchCache(queryClient, updated)
      setDrafts((prev) => ({ ...prev, [key]: updated.value }))
      markSaved(updated)
      setConflictBanner(null)
    } catch (err) {
      const apiErr = err as Partial<ApiError>
      setFieldErrors((prev) => ({
        ...prev,
        [key]:
          apiErr.message ?? 'Zurücksetzen fehlgeschlagen. Bitte erneut versuchen.',
      }))
    }
  }

  async function toggleFlag(key: string, next: boolean): Promise<void> {
    setDraft(key, next)
    await saveKey(key, next)
  }

  return (
    <section
      className="mx-auto w-full max-w-4xl px-5 py-10 md:px-8 md:py-14"
      aria-labelledby="extractor-config-heading"
    >
      <header className="mb-6">
        <h1
          id="extractor-config-heading"
          className="font-serif text-[clamp(30px,7vw,40px)] font-semibold leading-[1.05] tracking-[-0.015em]"
        >
          Extractor-Konfiguration
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Prompts, Modelle, Feature-Flags und Schwellenwerte für den
          Rezept-Extraktor — Änderungen wirken nach spätestens 60 Sekunden.
        </p>
      </header>

      {listQuery.isLoading && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          Lade Konfiguration …
        </p>
      )}

      {listQuery.isError && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200"
        >
          Konfiguration konnte nicht geladen werden.
        </p>
      )}

      {conflictBanner && (
        <p
          role="status"
          aria-live="polite"
          className="mb-6 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200"
        >
          {conflictBanner}
        </p>
      )}

      {listQuery.data && (
        <>
          <PromptsSection
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
            onSave={() => void saveSection('prompts')}
            onReset={(key) => void resetKey(key)}
          />

          <ModelsSection
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
            onSave={() => void saveSection('models')}
          />

          <FlagsSection
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            onToggle={(key, next) => void toggleFlag(key, next)}
          />

          <ThresholdsSection
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
            onSave={() => void saveSection('thresholds')}
          />

          <HistoryFooter />
        </>
      )}
    </section>
  )
}

// ── Sections ────────────────────────────────────────────────────────

interface SectionProps {
  baseline: BaselineMap
  drafts: DraftMap
  savedAt: SavedAtMap
  fieldErrors: FieldErrorMap
  setDraft: (key: string, value: unknown) => void
}

function PromptsSection(
  props: SectionProps & { onSave: () => void; onReset: (key: string) => void },
) {
  const { baseline, drafts, savedAt, fieldErrors, setDraft, onSave, onReset } =
    props
  return (
    <Card className="mb-6">
      <CardHeader>
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
          Prompts
        </h2>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            onSave()
          }}
          className="space-y-6"
        >
          {PROMPT_KEYS.map((key) => {
            const base = baseline[key]
            const value =
              typeof drafts[key] === 'string' ? (drafts[key] as string) : ''
            if (!base) return null
            return (
              <div
                key={key}
                data-testid="prompt-row"
                className="space-y-2"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={key} className="text-sm font-medium">
                    {key}
                  </Label>
                  <EditorChip item={base} />
                </div>
                <Textarea
                  id={key}
                  value={value}
                  onChange={(e) => setDraft(key, e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {value.length} Zeichen
                  </span>
                  <div className="flex items-center gap-3">
                    <SavedIndicator savedAt={savedAt[key]} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onReset(key)}
                    >
                      Zurücksetzen
                    </Button>
                  </div>
                </div>
                <FieldError message={fieldErrors[key]} />
              </div>
            )
          })}

          <div className="flex justify-end">
            <Button type="submit">Prompts speichern</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function ModelsSection(props: SectionProps & { onSave: () => void }) {
  const { baseline, drafts, savedAt, fieldErrors, setDraft, onSave } = props
  return (
    <Card className="mb-6">
      <CardHeader>
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
          Modelle &amp; Parameter
        </h2>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            onSave()
          }}
          className="space-y-8"
        >
          <ModelGroup
            title="Structured"
            deploymentKey="llm.structured.deployment"
            temperatureKey="llm.structured.temperature"
            maxTokensKey="llm.structured.max_completion_tokens"
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
          />
          <ModelGroup
            title="Chat"
            deploymentKey="llm.chat.deployment"
            maxTokensKey="llm.chat.max_completion_tokens"
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
          />
          <ModelGroup
            title="Vision"
            deploymentKey="llm.vision.deployment"
            temperatureKey="llm.vision.temperature"
            maxTokensKey="llm.vision.max_completion_tokens"
            baseline={baseline}
            drafts={drafts}
            savedAt={savedAt}
            fieldErrors={fieldErrors}
            setDraft={setDraft}
          />

          <div className="flex justify-end">
            <Button type="submit">Modelle speichern</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

interface ModelGroupProps extends SectionProps {
  title: string
  deploymentKey: string
  temperatureKey?: string
  maxTokensKey: string
}

function ModelGroup(props: ModelGroupProps) {
  const {
    title,
    deploymentKey,
    temperatureKey,
    maxTokensKey,
    baseline,
    drafts,
    savedAt,
    fieldErrors,
    setDraft,
  } = props
  return (
    <fieldset className="space-y-3">
      <legend className="font-serif text-lg font-semibold">{title}</legend>

      <StringField
        fieldKey={deploymentKey}
        baseline={baseline}
        drafts={drafts}
        savedAt={savedAt}
        fieldErrors={fieldErrors}
        setDraft={setDraft}
      />
      {temperatureKey && (
        <NumberField
          fieldKey={temperatureKey}
          min={0}
          max={2}
          step={0.1}
          baseline={baseline}
          drafts={drafts}
          savedAt={savedAt}
          fieldErrors={fieldErrors}
          setDraft={setDraft}
        />
      )}
      <NumberField
        fieldKey={maxTokensKey}
        min={100}
        max={8192}
        step={1}
        baseline={baseline}
        drafts={drafts}
        savedAt={savedAt}
        fieldErrors={fieldErrors}
        setDraft={setDraft}
      />
    </fieldset>
  )
}

function FlagsSection(props: {
  baseline: BaselineMap
  drafts: DraftMap
  savedAt: SavedAtMap
  fieldErrors: FieldErrorMap
  onToggle: (key: string, next: boolean) => void
}) {
  const { baseline, drafts, savedAt, fieldErrors, onToggle } = props
  return (
    <Card className="mb-6">
      <CardHeader>
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
          Feature-Flags
        </h2>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {FLAG_KEYS.map((key) => {
            const base = baseline[key]
            const checked = Boolean(drafts[key])
            if (!base) return null
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 py-3">
                <label htmlFor={key} className="flex-1 min-w-[200px] cursor-pointer">
                  <span className="block text-sm font-medium">{key}</span>
                  <span className="block text-xs text-muted-foreground">
                    {FLAG_LABELS[key]}
                  </span>
                </label>
                <SavedIndicator savedAt={savedAt[key]} />
                <EditorChip item={base} />
                <input
                  id={key}
                  type="checkbox"
                  role="switch"
                  checked={checked}
                  onChange={(e) => onToggle(key, e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                <FieldError message={fieldErrors[key]} />
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}

function ThresholdsSection(props: SectionProps & { onSave: () => void }) {
  const { baseline, drafts, savedAt, fieldErrors, setDraft, onSave } = props
  return (
    <Card className="mb-6">
      <CardHeader>
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
          Thresholds
        </h2>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault()
            onSave()
          }}
          className="space-y-4"
        >
          {THRESHOLD_NUMBER_KEYS.map((key) => (
            <NumberField
              key={key}
              fieldKey={key}
              min={0}
              step={key === 'pipeline.shortener_head_timeout_seconds' ? 0.5 : 1}
              baseline={baseline}
              drafts={drafts}
              savedAt={savedAt}
              fieldErrors={fieldErrors}
              setDraft={setDraft}
            />
          ))}
          {THRESHOLD_LIST_KEYS.map((key) => (
            <StringListField
              key={key}
              fieldKey={key}
              baseline={baseline}
              drafts={drafts}
              savedAt={savedAt}
              fieldErrors={fieldErrors}
              setDraft={setDraft}
            />
          ))}

          <div className="flex justify-end">
            <Button type="submit">Thresholds speichern</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function HistoryFooter() {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-serif text-2xl font-semibold leading-tight tracking-tight">
          Letzte Änderungen
        </h2>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Letzte Änderungen werden nachgerüstet.
        </p>
      </CardContent>
    </Card>
  )
}

// ── Field primitives ────────────────────────────────────────────────

interface FieldProps {
  fieldKey: string
  baseline: BaselineMap
  drafts: DraftMap
  savedAt: SavedAtMap
  fieldErrors: FieldErrorMap
  setDraft: (key: string, value: unknown) => void
}

function StringField(props: FieldProps) {
  const { fieldKey, baseline, drafts, savedAt, fieldErrors, setDraft } = props
  const base = baseline[fieldKey]
  if (!base) return null
  const value = typeof drafts[fieldKey] === 'string' ? (drafts[fieldKey] as string) : ''
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={fieldKey} className="text-sm font-medium">
          {fieldKey}
        </Label>
        <EditorChip item={base} />
      </div>
      <Input
        id={fieldKey}
        type="text"
        value={value}
        onChange={(e) => setDraft(fieldKey, e.target.value)}
      />
      <SavedIndicator savedAt={savedAt[fieldKey]} />
      <FieldError message={fieldErrors[fieldKey]} />
    </div>
  )
}

interface NumberFieldProps extends FieldProps {
  min?: number
  max?: number
  step?: number
}

function NumberField(props: NumberFieldProps) {
  const {
    fieldKey,
    baseline,
    drafts,
    savedAt,
    fieldErrors,
    setDraft,
    min,
    max,
    step = 1,
  } = props
  const base = baseline[fieldKey]
  if (!base) return null
  const raw = drafts[fieldKey]
  const displayValue =
    typeof raw === 'number'
      ? String(raw)
      : typeof raw === 'string'
        ? raw
        : ''
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={fieldKey} className="text-sm font-medium">
          {fieldKey}
        </Label>
        <EditorChip item={base} />
      </div>
      <Input
        id={fieldKey}
        type="number"
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onChange={(e) => {
          const str = e.target.value
          if (str === '') {
            setDraft(fieldKey, '')
            return
          }
          const parsed = Number(str)
          setDraft(fieldKey, Number.isFinite(parsed) ? parsed : str)
        }}
      />
      <SavedIndicator savedAt={savedAt[fieldKey]} />
      <FieldError message={fieldErrors[fieldKey]} />
    </div>
  )
}

function StringListField(props: FieldProps) {
  const { fieldKey, baseline, drafts, savedAt, fieldErrors, setDraft } = props
  const [input, setInput] = useState('')
  const base = baseline[fieldKey]
  if (!base) return null
  const list = Array.isArray(drafts[fieldKey])
    ? (drafts[fieldKey] as string[])
    : []

  function commit() {
    const trimmed = input.trim()
    if (!trimmed) return
    if (list.includes(trimmed)) {
      setInput('')
      return
    }
    setDraft(fieldKey, [...list, trimmed])
    setInput('')
  }

  function remove(entry: string) {
    setDraft(
      fieldKey,
      list.filter((x) => x !== entry),
    )
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  const addLabel = `${fieldKey} — Eintrag hinzufügen`

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={`${fieldKey}__input`} className="text-sm font-medium">
          {fieldKey}
        </Label>
        <EditorChip item={base} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.length === 0 && (
          <span className="text-xs text-muted-foreground">
            Noch keine Einträge.
          </span>
        )}
        {list.map((entry) => (
          <span
            key={entry}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
          >
            {entry}
            <button
              type="button"
              onClick={() => remove(entry)}
              aria-label={`${entry} entfernen`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          id={`${fieldKey}__input`}
          aria-label={addLabel}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Neuer Eintrag …"
        />
        <Button type="button" variant="outline" onClick={commit}>
          Hinzufügen
        </Button>
      </div>
      <SavedIndicator savedAt={savedAt[fieldKey]} />
      <FieldError message={fieldErrors[fieldKey]} />
    </div>
  )
}

// ── Indicators ──────────────────────────────────────────────────────

function EditorChip({ item }: { item: ExtractorConfigItem }) {
  if (!item.updatedBy) return null
  return (
    <span className="text-xs text-muted-foreground">
      Geändert von{' '}
      <span className="font-medium text-foreground">
        {item.updatedBy.displayName}
      </span>
    </span>
  )
}

function SavedIndicator({ savedAt }: { savedAt?: number }) {
  // `now` is re-read on an interval so the "Gespeichert vor X Sek."
  // label ticks forward. The lazy initialiser captures the first
  // `Date.now()` cleanly at mount; the interval updates `now` on a
  // 1-second cadence. A new `savedAt` triggers the effect to remount
  // the interval — the delta computation in render then naturally
  // starts from ~0 Sek because `now` and `savedAt` are set within a
  // few ms of each other.
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    if (savedAt === undefined) return
    const id = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(id)
    }
  }, [savedAt])

  if (savedAt === undefined) return null
  const deltaSec = Math.max(0, Math.floor((now - savedAt) / 1000))
  return (
    <span
      role="status"
      aria-live="polite"
      className="text-xs text-emerald-700"
    >
      Gespeichert vor {deltaSec} Sek.
    </span>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-800 ring-1 ring-red-200"
    >
      {message}
    </p>
  )
}

// ── Utilities ───────────────────────────────────────────────────────

function keysForSection(section: SectionKey): readonly string[] {
  switch (section) {
    case 'prompts':
      return PROMPT_KEYS
    case 'models':
      return MODEL_KEYS
    case 'flags':
      return FLAG_KEYS
    case 'thresholds':
      return [...THRESHOLD_NUMBER_KEYS, ...THRESHOLD_LIST_KEYS]
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
    return true
  }
  return false
}

/**
 * Swap the just-updated item into the cached list so the enclosing
 * `useQuery`'s `baseline` map picks up the fresh `version` on the next
 * render. We use `setQueryData` rather than mutating `listQuery.data`
 * to stay inside TanStack Query's cache discipline — structural sharing
 * won't cheat us out of a re-render.
 */
function patchCache(
  queryClient: ReturnType<typeof useQueryClient>,
  updated: ExtractorConfigItem,
): void {
  queryClient.setQueryData<ExtractorConfigListResponse>(
    LIST_QUERY_KEY,
    (prev) => {
      if (!prev) return prev
      return {
        items: prev.items.map((it) =>
          it.key === updated.key ? updated : it,
        ),
      }
    },
  )
}
