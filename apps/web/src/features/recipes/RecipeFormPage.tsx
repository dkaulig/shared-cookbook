import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type {
  ApiError,
  CreateRecipeRequest,
  IngredientConfidenceLevel,
  IngredientDto,
  RecipeDetailDto,
  RecipeStepDto,
  StepConfidenceLevel,
  TagCategory,
  TagDto,
  UpdateRecipeRequest,
} from '@familien-kochbuch/shared'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Plus, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGroup } from '@/features/groups/hooks'
import { CreateTagDialog } from '@/features/tagManagement/CreateTagDialog'
import { useImportStatus } from '@/features/imports/hooks'
import {
  extractedRecipeToPrefill,
  extractedResultToPrefill,
  type ImportPrefill,
  withImportEnvelope,
} from '@/features/imports/importPrefill'
import { EmptyExtractionExplainer } from './EmptyExtractionExplainer'
import {
  forgetChatImport,
  recallChatImport,
} from '@/features/chat/chatImportMemo'
import {
  recallImportStagedPhotos,
  rememberImportStagedPhotos,
  type ImportStagedPhotoMemo,
} from '@/features/imports/importGroupMemo'
import { deleteStagedPhoto } from '@/features/imports/stagedPhotoApi'
import {
  useCreateRecipe,
  useGroupTags,
  useRecipe,
  useUpdateRecipe,
} from './hooks'
import { CharCounter } from './CharCounter'
import { reorderAcrossComponents } from './componentReorder'
import { renderInlineMarkdown } from './markdownRenderer'
import { wrapSelection } from './markdownToolbarHelpers'
import { StepMarkdownToolbar } from './StepMarkdownToolbar'
import { DifficultyPills } from './DifficultyPills'
import type { DifficultyLevel } from './DifficultyPills'
import { FormActionBar } from './FormActionBar'
import { useBottomZoneSlot } from '@/components/layout/bottomZone'
import { FormIntro } from './FormIntro'
import { PhotoUploadGrid } from './PhotoUploadGrid'
import { uploadRecipePhoto } from './recipePhotoApi'
import { RecipeFormTopNav } from './RecipeFormTopNav'
import { RecipeConflictBody } from './RecipeConflictBody'
import type { RecipeConflictShape } from './RecipeConflictBody'
import {
  ConflictDialog,
  useConflictResolver,
} from '@/features/_shared/ConflictDialog'
import { VersionMismatchError } from '@/features/_shared/apiError'
import { useQueryClient } from '@tanstack/react-query'
import { recipeQueryKeys } from './queryKeys'

const UNITS = [
  'g',
  'kg',
  'ml',
  'l',
  'EL',
  'TL',
  'Stück',
  'Prise',
  'Bund',
  'Tasse',
  'Becher',
  'Scheibe',
  'Zehe',
  'nach Geschmack',
]

const CATEGORY_ORDER: readonly TagCategory[] = [
  'Mahlzeit',
  'Saison',
  'Typ',
  'Aufwand',
  'Diaet',
  'Kueche',
  // GR1 — Grundrezept-Tags for isolated sub-recipes. Rendered as its
  // own section between the predefined categories and the user-created
  // Custom block.
  'Komponente',
  'Custom',
]

const CATEGORY_LABELS: Record<TagCategory, string> = {
  Mahlzeit: 'Mahlzeit',
  Saison: 'Saison',
  Typ: 'Typ',
  Aufwand: 'Aufwand',
  Diaet: 'Diät',
  Kueche: 'Küche',
  Komponente: 'Komponente',
  Custom: 'Gruppen-Tags (Custom)',
}

const TITLE_MAX = 200
const DESC_MAX = 2000

type IngredientRow = {
  key: string
  quantity: string
  unit: string
  name: string
  note: string
  scalable: boolean
  /**
   * Provenance marker — only set when the row was seeded from an AI
   * import (P2-7). Drives the "Menge fehlt" / "Handschrift prüfen"
   * review badges. Undefined on manually-created rows so the renderer
   * skips the chrome entirely.
   */
  confidence?: IngredientConfidenceLevel
}

type StepRow = {
  key: string
  content: string
  /** Same provenance marker idea for steps — see IngredientRow. */
  confidence?: StepConfidenceLevel
}

/**
 * COMP-2 — one sub-recipe group in the form's in-memory state. Simple
 * recipes carry exactly one component with `label === null`; the
 * progressive-disclosure renderer collapses that case into the flat
 * pre-COMP-2 layout. Multi-component recipes have ≥2 entries, or 1
 * entry with a non-null label.
 *
 * Constants:
 *   - `label` is stored as `null` for the single-default component
 *     specifically so the default-render branch can still distinguish
 *     the implicit "no header needed" state from a user who typed
 *     empty text into the label input (stored as `""`, not `null`).
 *   - Label cap of 50 chars mirrors the Python post-processor's cap
 *     so the form can't produce a payload the backend would reject.
 */
const COMPONENT_LABEL_MAX = 50

type ComponentRow = {
  key: string
  label: string | null
  ingredients: IngredientRow[]
  steps: StepRow[]
}

function emptyIngredient(): IngredientRow {
  return {
    key: crypto.randomUUID(),
    quantity: '',
    unit: 'g',
    name: '',
    note: '',
    scalable: true,
  }
}

function emptyStep(): StepRow {
  return { key: crypto.randomUUID(), content: '' }
}

function ingredientFromDto(i: IngredientDto): IngredientRow {
  return {
    key: i.id ?? crypto.randomUUID(),
    quantity: i.quantity == null ? '' : String(i.quantity),
    unit: i.unit,
    name: i.name,
    note: i.note ?? '',
    scalable: i.scalable,
  }
}

function stepFromDto(s: RecipeStepDto): StepRow {
  return { key: s.id ?? crypto.randomUUID(), content: s.content }
}

function emptyComponent(label: string | null = ''): ComponentRow {
  return {
    key: crypto.randomUUID(),
    label,
    ingredients: [emptyIngredient()],
    steps: [emptyStep()],
  }
}

type Props = {
  mode: 'create' | 'edit'
}

/**
 * Wrapper: on edit we need the recipe loaded before rendering the inner
 * form, so we can initialise `useState` from the DTO on first render (no
 * setState-in-effect hack). Create mode skips the wait — unless the URL
 * carries an `?importId=…` from the P2-7 URL-import flow, in which case
 * we block render on fetching the import result and pass its
 * `ImportPrefill` into the inner form.
 */
export function RecipeFormPage({ mode }: Props) {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const recipeId = params.recipeId ?? ''
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const importId = mode === 'create' ? searchParams.get('importId') ?? '' : ''
  // BUG-034 — escape hatch for `EmptyExtractionExplainer`. When the
  // user clicks "Trotzdem leer anlegen" we flip this flag and let the
  // normal inner form render with the empty prefill (fallback title
  // "Unbekanntes Rezept" + any auto-attached thumbnail). The flag
  // is intentionally component-scoped so re-mounting the page (e.g.
  // navigating away and back) resets it.
  const [proceedAnyway, setProceedAnyway] = useState(false)
  // P2-9 — the chat-to-recipe handoff stashes the ExtractionResult in
  // sessionStorage under a transient id the URL carries via
  // `?chatImportId=<uuid>`. Reads happen once on first render (the
  // outer wrapper is a natural gate for prefill composition). We keep
  // the stashed payload around until the user saves or explicitly
  // discards — see `chatImport.onDiscard` wiring below.
  const chatImportId =
    mode === 'create' ? searchParams.get('chatImportId') ?? '' : ''

  const recipeQuery = useRecipe(mode === 'edit' ? recipeId : undefined)
  // useImportStatus manages its own enabled/disabled logic. When
  // importId is an empty string we disable the query via `enabled: false`.
  const importQuery = useImportStatus(importId || undefined, {
    // Short-circuit polling — by the time the user lands on this page
    // the import has already completed. If it somehow hasn't, we still
    // fall through to the 2 s default interval.
    enabled: importId.length > 0,
    // BUG-017 — force a fresh fetch on mount so the form page never
    // trusts a SignalR-polluted cache entry left behind by the
    // `ImportProgressPage` auto-redirect. If the cache is up-to-date
    // the refetch is cheap; if it's stale/partial we block on loading
    // instead of committing empty useState values in the inner form.
    refetchOnMount: 'always',
  })

  if (mode === 'edit' && recipeQuery.isLoading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 text-[hsl(var(--muted-foreground))]">
        Lade Rezept …
      </main>
    )
  }

  if (mode === 'edit' && (recipeQuery.isError || !recipeQuery.data)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p
          role="alert"
          className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          Rezept konnte nicht geladen werden.
        </p>
      </main>
    )
  }

  // Block render on the import fetch — we can't initialise the inner
  // form's state from the prefill after the first render without the
  // same setState-in-effect hack the edit path avoids. The wait is
  // cheap (the import has already completed; this is a single GET).
  if (importId && importQuery.isLoading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 text-[hsl(var(--muted-foreground))]">
        Lade Import-Vorschau …
      </main>
    )
  }

  // BUG-017 race-guard: the cache may transiently have `status: 'done'`
  // with `result: null` (e.g. SignalR merged a progress update before
  // polling caught up; `ImportProgressPage` auto-redirected us here
  // with that partial entry). Block Inner-render until the result is
  // actually populated — otherwise `RecipeFormInner`'s useState
  // initializers commit empty values permanently, and the subsequent
  // rerender with populated prefill has no way to update them.
  if (
    importId &&
    importQuery.data?.status === 'done' &&
    !importQuery.data.result
  ) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10 text-[hsl(var(--muted-foreground))]">
        Lade Rezept-Daten …
      </main>
    )
  }

  // Explicit error state — the backend signalled the import failed,
  // so there is no prefill to render. Surface the server message
  // instead of falling through to an empty form.
  if (importId && importQuery.data?.status === 'error') {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p
          role="alert"
          className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
        >
          Import fehlgeschlagen:{' '}
          {importQuery.data.errorMessage ?? 'Unbekannter Fehler'}
        </p>
      </main>
    )
  }

  // Prefill resolution order: URL import (Hangfire-polled) → chat
  // import (synchronous sessionStorage stash). The two paths are
  // mutually exclusive by construction — the source URL is either
  // an `/api/imports/{importId}` payload or the chat → recipe
  // structuring output — but the chain-of-responsibility below is
  // cheap and defensive.
  let prefill: ImportPrefill | undefined
  let chatImportSource: 'chat' | null = null
  if (mode === 'create' && importQuery.data?.result) {
    // BUG-034 — use `extractedResultToPrefill` so the outer-envelope
    // `recipe_empty` / `empty_reason` flags land on the prefill and
    // the wrapper can branch into `EmptyExtractionExplainer` below.
    prefill = extractedResultToPrefill(importQuery.data.result)
    // BUG-018 — overlay the import-DTO-level fields (only the auto-
    // attached video-thumbnail staged-photo id today) the inner
    // recipe shape can't see.
    prefill = withImportEnvelope(prefill, {
      thumbnailStagedPhotoId: importQuery.data.thumbnailStagedPhotoId ?? null,
    })
  } else if (mode === 'create' && chatImportId) {
    const stashed = recallChatImport(chatImportId)
    if (stashed) {
      // Chat imports go through the inner-recipe path — chat sessions
      // produce a recipe by construction (the user authored it), so
      // the empty-gate doesn't apply here; legacy `extractedRecipeToPrefill`
      // keeps `recipeEmpty=false`.
      prefill = extractedRecipeToPrefill(stashed.result.recipe)
      chatImportSource = 'chat'
    }
    // If the stash is missing (bookmarked link, expired tab) we fall
    // through to a blank create form — the user keeps their URL but
    // loses the chat payload, which is an acceptable outcome for a
    // deliberately session-scoped feature.
  }

  // BUG-034 — if the extractor returned an empty recipe (no ingredients
  // AND no steps) and the user hasn't yet clicked "Trotzdem leer
  // anlegen", render the explainer instead of the silent empty form.
  // The inner form still renders when `proceedAnyway` flips (escape
  // hatch) so the user isn't locked out of the manual-entry path.
  if (mode === 'create' && prefill?.recipeEmpty && !proceedAnyway) {
    return (
      <EmptyExtractionExplainer
        reason={prefill.emptyReason}
        sourceUrl={
          // `sourceUrl` on the prefill has the photos:// sentinel
          // stripped; fall back to the raw import DTO URL so the
          // chip shows what the user actually submitted.
          prefill.sourceUrl !== ''
            ? prefill.sourceUrl
            : importQuery.data?.sourceUrl ?? null
        }
        signals={prefill.signals}
        onProceedEmpty={() => setProceedAnyway(true)}
        onTryAnother={() => navigate('/rezepte/import')}
      />
    )
  }

  // Read at the wrapper level so the inner form can seed its
  // initial state without the setState-in-effect dance.
  //
  // BUG-018 — additionally fold in the auto-attached video-thumbnail
  // staged-photo id (URL-import path) so the create-recipe POST
  // promotes it alongside any user-uploaded photos. Photo-import path
  // doesn't carry a thumbnail (the user is the photo source).
  //
  // BUG-024 — we now surface these as {id, url} pairs so the review
  // form can render the actual thumbnails via
  // `PhotoUploadGrid.preAttached`. The BUG-018 thumbnail is a special
  // case: the frontend doesn't have a signed URL for it (the import
  // status endpoint only exposes the id), so we fall back to a
  // url-less entry — the inner form filters those out before passing
  // them to the grid, so the thumbnail stays "badge only" until /
  // unless the backend starts exposing its url too.
  const initialPreAttached: ImportStagedPhotoMemo[] = (() => {
    if (mode !== 'create' || !importId) return []
    const base = prefill?.isPhotoImport
      ? recallImportStagedPhotos(importId) ?? []
      : []
    const thumbId = prefill?.thumbnailStagedPhotoId
    if (!thumbId) return base
    // Mark the thumbnail with an empty url so the grid can skip the
    // <img> render (no signed URL available today).
    return [...base, { stagedPhotoId: thumbId, url: '' }]
  })()

  return (
    <RecipeFormInner
      mode={mode}
      initial={mode === 'edit' ? recipeQuery.data! : undefined}
      prefill={prefill}
      chatImportId={chatImportSource ? chatImportId : null}
      importId={importId ?? null}
      initialPreAttached={initialPreAttached}
      thumbnailStagedPhotoId={prefill?.thumbnailStagedPhotoId ?? null}
    />
  )
}

function RecipeFormInner({
  mode,
  initial,
  prefill,
  chatImportId,
  importId,
  initialPreAttached,
  thumbnailStagedPhotoId,
}: {
  mode: 'create' | 'edit'
  initial?: RecipeDetailDto
  prefill?: ImportPrefill
  /**
   * Non-null when the prefill came from the P2-9 chat → recipe handoff.
   * Used to (a) swap the banner copy to the chat-specific variant,
   * (b) drop the sessionStorage stash once the recipe saves
   * successfully or the user explicitly cancels.
   */
  chatImportId?: string | null
  /**
   * BUG-024 — the importId the wrapper resolved (`null` in non-import
   * create/edit). Needed so the remove-preAttached handler can
   * update the sessionStorage memo after a successful delete.
   */
  importId?: string | null
  /**
   * BUG-024 — server-side staged photos the wrapper recalled from the
   * session memo (user-uploaded originals) plus the optional BUG-018
   * video thumbnail. Each entry carries the signed SeaweedFS URL so
   * the grid can render a thumbnail; entries with an empty URL (e.g.
   * the BUG-018 thumbnail whose URL isn't exposed to the frontend)
   * are still forwarded into the save payload but omitted from the
   * visible grid, so BUG-018 keeps its pre-BUG-024 "badge only"
   * fallback.
   */
  initialPreAttached?: readonly ImportStagedPhotoMemo[]
  /**
   * BUG-018 — present when the URL-import job auto-attached a video
   * thumbnail. Forwarded into the save payload but rendered as "badge
   * only" (no signed URL available on the frontend yet).
   */
  thumbnailStagedPhotoId?: string | null
}) {
  const params = useParams<{ groupId: string; recipeId: string }>()
  const navigate = useNavigate()
  const groupId = params.groupId ?? ''
  const recipeId = params.recipeId ?? ''

  const groupQuery = useGroup(groupId)
  const tagsQuery = useGroupTags(groupId)
  const createMutation = useCreateRecipe(groupId)
  const updateMutation = useUpdateRecipe(recipeId, groupId)
  const queryClient = useQueryClient()

  // OFF4 — conflict resolver for the recipe PUT. `pendingPayload`
  // stashes the most-recent submit payload so keep-local retries can
  // re-dispatch against the server's current version without asking the
  // user to re-type anything.
  const pendingPayloadRef = useRef<UpdateRecipeRequest | null>(null)
  const conflict = useConflictResolver<RecipeConflictShape>({
    onKeepLocal: async (expectedVersion) => {
      const body = pendingPayloadRef.current
      if (!body) return
      // Re-dispatch the same payload, forcing the new expectedVersion
      // onto the If-Match header so the retry lands against the
      // server's latest state.
      await updateMutation.mutateAsync({ body, expectedVersion })
      navigate(`/groups/${groupId}/recipes/${recipeId}`)
    },
    onKeepServer: () => {
      // Abort local change — re-fetch the server version so the form
      // reflects truth. We also clear the form-level error + navigate
      // back to the recipe detail where the user can re-edit.
      void queryClient.invalidateQueries({
        queryKey: recipeQueryKeys.detail(recipeId),
      })
    },
  })
  const [mergeEditorOpen, setMergeEditorOpen] = useState(false)
  const mergedRef = useRef<RecipeConflictShape | null>(null)

  // Initial state resolution order: edit DTO > import prefill > blank.
  // We intentionally keep `initial` and `prefill` mutually exclusive —
  // the outer wrapper only ever passes one — so the fallback chain
  // stays readable.
  const [title, setTitle] = useState(initial?.title ?? prefill?.title ?? '')
  const [description, setDescription] = useState(
    initial?.description ?? prefill?.description ?? '',
  )
  const [defaultServings, setDefaultServings] = useState(
    initial?.defaultServings ?? prefill?.defaultServings ?? 4,
  )
  const [prepTime, setPrepTime] = useState(
    initial?.prepTimeMinutes != null
      ? String(initial.prepTimeMinutes)
      : prefill?.prepTimeMinutes != null
        ? String(prefill.prepTimeMinutes)
        : '',
  )
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(
    (initial?.difficulty as DifficultyLevel | undefined) ??
      (prefill?.difficulty as DifficultyLevel | undefined) ??
      1,
  )
  const [sourceUrl, setSourceUrl] = useState(() => {
    if (initial?.sourceUrl != null) return initial.sourceUrl
    // Chat imports emit a synthetic `chat://…` URL the user never
    // pasted — strip it here so the saved recipe doesn't persist the
    // sentinel as a junk "source" link. Mirrors the photo-import
    // sentinel stripping in extractedRecipeToPrefill.
    if (chatImportId && prefill?.sourceUrl.startsWith('chat://')) return ''
    return prefill?.sourceUrl ?? ''
  })
  // COMP-2 — one state slot for all nested components. Seeding order:
  //   1. Edit mode: pick up server `initial.components`, mapping each
  //      ingredient/step DTO to the row shape.
  //   2. Create + prefill mode: hydrate from `prefill.components`
  //      (already normalised by extractedRecipeToPrefill).
  //   3. Fresh create: single default component with one empty row
  //      each — matches the pre-COMP-2 empty-state UX.
  const [components, setComponents] = useState<ComponentRow[]>(() => {
    if (initial && initial.components.length > 0) {
      const sorted = [...initial.components].sort(
        (a, b) => a.position - b.position,
      )
      return sorted.map((c) => ({
        key: c.id ?? crypto.randomUUID(),
        label: c.label,
        ingredients:
          c.ingredients.length > 0
            ? c.ingredients.map(ingredientFromDto)
            : [emptyIngredient()],
        steps:
          c.steps.length > 0
            ? c.steps.map(stepFromDto)
            : [emptyStep()],
      }))
    }
    if (prefill && prefill.components.length > 0) {
      return prefill.components.map((c) => ({
        key: crypto.randomUUID(),
        label: c.label,
        ingredients:
          c.ingredients.length > 0
            ? c.ingredients.map((i) => ({
                key: crypto.randomUUID(),
                quantity: i.quantity,
                unit: i.unit,
                name: i.name,
                note: i.note,
                scalable: i.scalable,
                confidence: i.confidence,
              }))
            : [emptyIngredient()],
        steps:
          c.steps.length > 0
            ? c.steps.map((s) => ({
                key: crypto.randomUUID(),
                content: s.content,
                confidence: s.confidence,
              }))
            : [emptyStep()],
      }))
    }
    return [
      {
        key: crypto.randomUUID(),
        label: null,
        ingredients: [emptyIngredient()],
        steps: [emptyStep()],
      },
    ]
  })

  // COMP-2 — progressive disclosure: default mode (single component
  // with `label: null`) renders exactly like the pre-COMP-2 form.
  // Multi-component mode fires whenever either condition flips.
  const isMultiComponentMode =
    components.length > 1 ||
    (components[0] && components[0].label !== null)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(
    () => initial?.tags.map((t) => t.id) ?? [],
  )
  // BUG-045 — the extractor returns tag names (lowercase German slugs)
  // but chip selection is id-keyed; we can only resolve names → ids
  // once the tag catalogue (`useGroupTags`) has loaded. This block
  // follows React's "Adjusting State on Props Change" pattern: during
  // render we check a one-shot flag and, when the catalogue is ready,
  // resolve-and-setState inline so the next render sees the merged
  // selection without a second paint. The `prefillTagsApplied` flag
  // ensures we only seed once — user toggles after that are preserved.
  const prefillTagNames = prefill?.tags
  const [prefillTagsApplied, setPrefillTagsApplied] = useState(false)
  if (
    !prefillTagsApplied
    && prefillTagNames !== undefined
    && prefillTagNames.length > 0
    && tagsQuery.data !== undefined
  ) {
    const nameToId = new Map<string, string>()
    for (const tag of tagsQuery.data) {
      nameToId.set(tag.name.toLowerCase(), tag.id)
    }
    const resolvedIds: string[] = []
    for (const name of prefillTagNames) {
      const id = nameToId.get(name.trim().toLowerCase())
      if (id && !resolvedIds.includes(id)) resolvedIds.push(id)
    }
    setPrefillTagsApplied(true)
    if (resolvedIds.length > 0) {
      // Merge (don't clobber) so any edit-mode `initial.tags` that
      // happen to share ids stay selected. Duplicates are filtered.
      setSelectedTagIds((prev) => {
        const merged = [...prev]
        for (const id of resolvedIds) {
          if (!merged.includes(id)) merged.push(id)
        }
        return merged
      })
    }
  }
  // P2-10: prefill-only read-only state. The form doesn't allow editing
  // nutrition at create-time (the PRD says "user can edit on
  // DetailPage after save"); this state is just a pass-through to the
  // save payload + a value for the preview section below.
  const [prefillNutrition] = useState(prefill?.nutritionEstimate ?? null)
  const [createTagOpen, setCreateTagOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * P2-7 — the AI banner surfaces the extraction provenance and is
   * independent of the prefilled data. Dismissing hides the banner;
   * the form state stays populated.
   */
  const [bannerDismissed, setBannerDismissed] = useState(false)
  // UX1-PU — File objects queued by the staged PhotoUploadGrid in create
  // mode. After the recipe POST resolves, handleSubmit iterates these
  // sequentially via uploadRecipePhoto(newRecipeId, file).
  const [stagedPhotos, setStagedPhotos] = useState<File[]>([])
  // BUG-024 — server-side staged photos seeded from the import memo.
  // Kept in React state so the remove-preAttached handler can drop an
  // entry after a successful DELETE without re-reading sessionStorage.
  // The wrapper computes the initial list once; from there we treat
  // it as pure UI state.
  const [preAttached, setPreAttached] = useState<
    readonly ImportStagedPhotoMemo[]
  >(() => initialPreAttached ?? [])
  // Drives the submit-button label: 'idle' shows the primary label,
  // 'saving' shows "Speichere …", 'uploading-photos' shows
  // "Fotos hochladen …" during the sequential photo-upload phase.
  const [submitPhase, setSubmitPhase] = useState<
    'idle' | 'saving' | 'uploading-photos'
  >('idle')

  // BUG-024 — the ids we forward into the create-recipe payload are
  // the preAttached list plus the BUG-018 thumbnail id (if not
  // already present). The thumbnail id is folded in defensively in
  // case the wrapper wasn't able to tag it with a URL (see
  // initialPreAttached comment in the wrapper).
  const stagedPhotoIds: string[] = (() => {
    const ids = preAttached.map((p) => p.stagedPhotoId)
    if (thumbnailStagedPhotoId && !ids.includes(thumbnailStagedPhotoId)) {
      ids.push(thumbnailStagedPhotoId)
    }
    return ids
  })()

  // BUG-024 — tiles the grid should render (must have a URL; the
  // BUG-018 thumbnail without a URL stays out of the visible grid
  // and remains represented only by the amber "wird beim Speichern
  // angehängt" pill).
  const gridPreAttached = preAttached
    .filter((p) => p.url !== '')
    .map((p) => ({
      stagedPhotoId: p.stagedPhotoId,
      url: p.url,
      isThumbnail:
        thumbnailStagedPhotoId != null &&
        p.stagedPhotoId === thumbnailStagedPhotoId,
    }))

  async function handleRemovePreAttached(stagedPhotoId: string): Promise<void> {
    // Optimistic removal — the X disappearing immediately matches
    // the live-photo remove UX. If the DELETE 404s (server already
    // swept the blob, another tab removed it) we still leave the
    // tile out; a 5xx re-surfaces via the banner below.
    const next = preAttached.filter((p) => p.stagedPhotoId !== stagedPhotoId)
    setPreAttached(next)
    if (importId) {
      // Persist the updated list so a later refresh doesn't resurrect
      // the tile. Drops the memo entirely when the list is empty so
      // the "zero staged photos" signal survives a reload.
      if (next.length === 0) {
        rememberImportStagedPhotos(importId, [])
      } else {
        rememberImportStagedPhotos(importId, next)
      }
    }
    try {
      await deleteStagedPhoto(stagedPhotoId)
    } catch (err) {
      const apiErr = err as ApiError
      // 404 = already gone (swept / removed in another tab) — leave
      // the tile out, no user-facing banner needed. Surface every
      // other error so the user understands the tile may reappear on
      // the saved recipe.
      if (apiErr.code !== 'not_found' && apiErr.code !== 'http_404') {
        setError(
          apiErr.message ?? 'Importiertes Foto konnte nicht entfernt werden.',
        )
      }
    }
  }

  const tagsByCategory = useMemo(() => {
    const grouped = new Map<TagCategory, TagDto[]>()
    for (const tag of tagsQuery.data ?? []) {
      const cat = tag.category
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat)!.push(tag)
    }
    return grouped
  }, [tagsQuery.data])

  // One shared sensor config for both the ingredient and the step DndContext.
  // PointerSensor covers mouse/touch; KeyboardSensor keeps reorder accessible.
  const dndSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ── COMP-2 component mutators ────────────────────────────────────
  // All ingredient + step mutations are scoped by componentIndex so
  // the same row-level handlers work in both single- and multi-
  // component mode. Single-default mode always passes componentIndex:0.

  function updateIngredient(
    componentIndex: number,
    rowIndex: number,
    updater: (row: IngredientRow) => IngredientRow,
  ) {
    setComponents((prev) =>
      prev.map((c, i) =>
        i === componentIndex
          ? {
              ...c,
              ingredients: c.ingredients.map((row, j) =>
                j === rowIndex ? updater(row) : row,
              ),
            }
          : c,
      ),
    )
  }

  function updateStep(componentIndex: number, rowIndex: number, content: string) {
    setComponents((prev) =>
      prev.map((c, i) =>
        i === componentIndex
          ? {
              ...c,
              steps: c.steps.map((row, j) =>
                j === rowIndex ? { ...row, content } : row,
              ),
            }
          : c,
      ),
    )
  }

  function addIngredientRow(componentIndex: number) {
    setComponents((prev) =>
      prev.map((c, i) =>
        i === componentIndex
          ? { ...c, ingredients: [...c.ingredients, emptyIngredient()] }
          : c,
      ),
    )
  }

  function removeIngredientRow(componentIndex: number, rowIndex: number) {
    setComponents((prev) =>
      prev.map((c, i) => {
        if (i !== componentIndex) return c
        if (c.ingredients.length <= 1) return c
        return {
          ...c,
          ingredients: c.ingredients.filter((_, j) => j !== rowIndex),
        }
      }),
    )
  }

  function addStepRow(componentIndex: number) {
    setComponents((prev) =>
      prev.map((c, i) =>
        i === componentIndex ? { ...c, steps: [...c.steps, emptyStep()] } : c,
      ),
    )
  }

  function removeStepRow(componentIndex: number, rowIndex: number) {
    setComponents((prev) =>
      prev.map((c, i) => {
        if (i !== componentIndex) return c
        if (c.steps.length <= 1) return c
        return { ...c, steps: c.steps.filter((_, j) => j !== rowIndex) }
      }),
    )
  }

  function updateComponentLabel(componentIndex: number, label: string) {
    // Cap applied at mutate time so pasting long text gets visually
    // clamped; mirrors the Python post-processor's 50-char enforcement.
    const capped = label.slice(0, COMPONENT_LABEL_MAX)
    setComponents((prev) =>
      prev.map((c, i) => (i === componentIndex ? { ...c, label: capped } : c)),
    )
  }

  function addComponent() {
    // When flipping from single-default to multi-component mode (i.e.
    // the user's first click), promote the existing default to an
    // empty-labelled component so the UI can render its label input
    // immediately. Subsequent adds just push a fresh empty component.
    setComponents((prev) => {
      const next = prev.map((c) =>
        c.label == null ? { ...c, label: '' } : c,
      )
      return [...next, emptyComponent('')]
    })
  }

  function removeComponent(componentIndex: number) {
    setComponents((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((_, i) => i !== componentIndex)
    })
  }

  function toggleTag(id: string) {
    setSelectedTagIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))
  }

  /**
   * COMP-2 — dnd-kit drag-end across all components. Each sortable row
   * is keyed by `ingredientRow.key` (or `stepRow.key`), making both
   * intra-component and cross-component moves work with a single
   * `arrayMove`-equivalent on a flattened list. We re-split the
   * flattened list back into components by re-reading each row's
   * parent index from the pre-move state.
   *
   * Boundary conditions:
   *   - The active or over row ids identify rows uniquely across all
   *     components.
   *   - Same-component reorder falls out naturally (the rows stay in
   *     the same component).
   *   - Cross-component moves update both the source and destination
   *     component's rows atomically.
   */
  function handleIngredientDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setComponents((prev) => reorderAcrossComponents(prev, 'ingredients', active.id, over.id))
  }

  function handleStepDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setComponents((prev) => reorderAcrossComponents(prev, 'steps', active.id, over.id))
  }

  function cancel() {
    // P2-9 — if the prefill came from the chat flow, discard the
    // sessionStorage stash on explicit cancel so the user's dialogue
    // doesn't linger for the next tab visit. We keep the stash when
    // the user saves (cleared at the end of handleSubmit instead),
    // to avoid wiping mid-save on transient navigation.
    if (chatImportId) forgetChatImport(chatImportId)
    navigate(`/groups/${groupId}`)
  }

  async function handleSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault()
    setError(null)

    if (title.trim().length === 0) {
      setError('Titel ist erforderlich.')
      return
    }

    // COMP-2 — build nested components payload. Each component keeps
    // its own ingredient + step arrays; positions re-number inside
    // each component (0..n-1). A component with zero usable rows is
    // dropped entirely — the same "mindestens 1 Zutat + 1 Schritt"
    // validation applies, but now it applies to the *total* across
    // components: at least one component must survive, and at least
    // one ingredient + one step must exist somewhere. Per-component
    // "empty sauce = drop" matches the pre-COMP-2 behaviour of
    // filtering blank rows.
    const componentsPayload = components
      .map((c, ci) => {
        const usableIngredients = c.ingredients.filter(
          (i) => i.name.trim().length > 0,
        )
        const usableSteps = c.steps.filter((s) => s.content.trim().length > 0)
        const ingredients = usableIngredients.map((row, idx) => {
          const trimmed = row.quantity.trim()
          // "nach Geschmack" is a unit convention that always implies a null
          // quantity (the renderer shows italic "nach Geschmack" text and
          // the scaler skips the row).
          const noQty = trimmed === '' || row.unit === 'nach Geschmack'
          // BUG-044 — normalise German comma-decimal before Number().
          // `Number("0,25")` is NaN → JSON.stringify serialises NaN as
          // `null` → backend sees `{quantity: null, scalable: true}` and
          // throws because "unscalable requires null quantity". Result
          // was a 400 invalid_input on any import that surfaced a
          // fractional quantity from a German-language source.
          const parsed = noQty ? null : Number(trimmed.replace(',', '.'))
          // Fallthrough safety: if the user typed garbage ("abc"), parsed
          // is NaN too — treat as missing quantity + force scalable=false
          // so the payload stays schema-valid.
          const quantity = parsed != null && Number.isFinite(parsed) ? parsed : null
          return {
            position: idx,
            quantity,
            unit: row.unit.trim(),
            name: row.name.trim(),
            note: row.note.trim() === '' ? undefined : row.note.trim(),
            scalable: quantity == null ? false : row.scalable,
          }
        })
        const steps = usableSteps.map((row, idx) => ({
          position: idx,
          content: row.content.trim(),
        }))
        // Normalise empty-string label → null so the single-default
        // component can still round-trip through "default mode" on the
        // next edit if the user wiped the label.
        const rawLabel = c.label
        const label =
          rawLabel === null
            ? null
            : rawLabel.trim() === ''
              ? null
              : rawLabel.trim()
        return {
          position: ci,
          label,
          ingredients,
          steps,
        }
      })
      .filter((c) => c.ingredients.length > 0 || c.steps.length > 0)
      // Renumber positions after drops so the server never sees gaps.
      .map((c, idx) => ({ ...c, position: idx }))

    const totalIngredients = componentsPayload.reduce(
      (sum, c) => sum + c.ingredients.length,
      0,
    )
    const totalSteps = componentsPayload.reduce(
      (sum, c) => sum + c.steps.length,
      0,
    )
    if (totalIngredients === 0) {
      setError('Mindestens eine Zutat ist erforderlich.')
      return
    }
    if (totalSteps === 0) {
      setError('Mindestens ein Schritt ist erforderlich.')
      return
    }

    const payload: CreateRecipeRequest = {
      title: title.trim(),
      description: description.trim() === '' ? undefined : description.trim(),
      // DS5 handoff: scaleIngredients() throws on 0/negative, so clamp
      // the persisted default-servings to ≥ 1 regardless of what the
      // user typed.
      defaultServings: Math.max(1, defaultServings),
      prepTimeMinutes: prepTime.trim() === '' ? undefined : Number(prepTime),
      difficulty,
      sourceUrl: sourceUrl.trim() === '' ? undefined : sourceUrl.trim(),
      components: componentsPayload,
      tagIds: selectedTagIds,
      // P2-10: include the prefill's nutrition estimate in the
      // create-recipe payload. The edit path (mode === 'edit') doesn't
      // carry a prefill, so this is naturally omitted there — nutrition
      // edits post-save go through PATCH /nutrition instead.
      nutritionEstimate: prefillNutrition,
      // Edit mode + non-photo imports leave this undefined, so the
      // server treats it as a standard manual create.
      stagedPhotoIds:
        mode === 'create' && stagedPhotoIds && stagedPhotoIds.length > 0
          ? stagedPhotoIds
          : undefined,
    }

    try {
      setSubmitPhase('saving')
      // OFF4 — stash the payload so the conflict resolver's keep-local
      // retry can re-dispatch without asking the user to re-type
      // anything. Only relevant on edit-mode; create has no If-Match
      // surface.
      if (mode === 'edit') pendingPayloadRef.current = payload
      const result =
        mode === 'create'
          ? await createMutation.mutateAsync(payload)
          : await updateMutation.mutateAsync(payload)

      // Capture server-side promote failures BEFORE the client-side
      // PhotoUploadGrid uploads so the user sees a single banner
      // covering both classes of failure.
      const promoteFailures = result.partialPhotoFailures ?? []
      const promoteAttempted = stagedPhotoIds?.length ?? 0

      // UX1-PU: if there are photos staged from create mode, upload them
      // sequentially now that we have a real recipe id. We intentionally
      // `await` in a plain for-loop instead of `Promise.all` so a single
      // transient failure (e.g. 413 on one big file) doesn't cascade
      // into the others. Errors are accumulated; the first message is
      // surfaced in the partial-failure banner.
      if (mode === 'create' && stagedPhotos.length > 0) {
        setSubmitPhase('uploading-photos')
        const failures: string[] = []
        for (const file of stagedPhotos) {
          try {
            await uploadRecipePhoto(result.id, file)
          } catch (err) {
            const apiErr = err as ApiError
            failures.push(apiErr.message ?? 'Upload fehlgeschlagen.')
          }
        }
        if (failures.length > 0) {
          // Partial (or total) photo-upload failure — the recipe itself
          // was saved fine, so we show the banner on the form and keep
          // the user here so they read it. They can navigate themselves
          // via the nav bar / top-left back; the retry lives on the
          // recipe's detail page. Sequentially-ordered: banner first,
          // then clear the uploading-photos pending state so the
          // primary button re-enables.
          setError(
            `Rezept gespeichert, aber ${failures.length} von ${stagedPhotos.length} Fotos konnten nicht hochgeladen werden: ${failures[0]} Du kannst sie auf der Rezept-Seite nachtragen.`,
          )
          setSubmitPhase('idle')
          return
        }
      }

      // Server-side promote failures keep us on the form: the recipe
      // row is saved + surviving photos are attached, so the user can
      // re-upload the missing ones from the detail page.
      if (promoteFailures.length > 0) {
        setError(
          `Rezept gespeichert, aber ${promoteFailures.length} von ${promoteAttempted} Fotos konnten nicht angehängt werden — bitte manuell hochladen.`,
        )
        setSubmitPhase('idle')
        return
      }

      setSubmitPhase('idle')
      // P2-9 — clean the sessionStorage stash once the recipe lives in
      // the DB. Skipped if chatImportId is null so the URL / photo
      // import paths are unaffected.
      if (chatImportId) forgetChatImport(chatImportId)
      navigate(`/groups/${groupId}/recipes/${result.id}`)
    } catch (err) {
      setSubmitPhase('idle')
      // OFF4 — a 409 VersionMismatchError surfaces the conflict dialog
      // rather than a generic error banner. `current` on the error is
      // the server's RecipeDetailDto at the time of the 409; we
      // project the local form state onto the same shape so the body
      // can diff the two sides.
      if (err instanceof VersionMismatchError && mode === 'edit') {
        // COMP-2 — flatten components → flat ingredients/steps for the
        // conflict body, which renders count-delta summaries and
        // doesn't surface components today. Preserves pre-COMP-2 UX.
        const flatIngredients = payload.components.flatMap((c) => c.ingredients)
        const flatSteps = payload.components.flatMap((c) => c.steps)
        const localShape: RecipeConflictShape = {
          id: recipeId,
          title: payload.title,
          description: payload.description ?? null,
          ingredients: flatIngredients,
          steps: flatSteps,
          version:
            (queryClient.getQueryData<RecipeDetailDto>(
              recipeQueryKeys.detail(recipeId),
            )?.version ?? 0) as number,
        }
        // Project the server's 409 `current` DTO onto the same flat
        // conflict shape. The raw server payload carries `components`
        // (not flat ingredients/steps) so the conflict body needs the
        // same flattening applied before it renders count-deltas.
        const serverCurrent = err.current as RecipeDetailDto | null
        if (serverCurrent) {
          const serverConflictShape: RecipeConflictShape = {
            id: serverCurrent.id,
            title: serverCurrent.title,
            description: serverCurrent.description ?? null,
            ingredients: serverCurrent.components.flatMap((c) => c.ingredients),
            steps: serverCurrent.components.flatMap((c) => c.steps),
            version: serverCurrent.version,
          }
          conflict.captureFrom409(localShape, { current: serverConflictShape })
        } else {
          conflict.captureFrom409(localShape, err)
        }
        return
      }
      const apiErr = err as ApiError
      setError(apiErr.message || 'Rezept konnte nicht gespeichert werden.')
    }
  }

  // UX1-PU — include the photo-upload phase so the button stays disabled
  // after the recipe mutation settles but while we're still uploading the
  // staged files.
  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    submitPhase === 'uploading-photos'
  const hasCustomCategory = tagsByCategory.has('Custom')

  // BUG-036 — push the 2-button form row into the unified Bottom-Zone
  // slot. Previously `<FormActionBar>` rendered as a fixed overlay at
  // the end of the page; now it lives in the same shared container as
  // BottomNav itself. We route the button callbacks through refs so
  // the slot doesn't need to refresh on every keystroke just to pick
  // up the latest closure over form state. Refs are written from an
  // effect (not during render) to satisfy the `react-hooks/refs`
  // lint rule.
  const cancelRef = useRef(cancel)
  const submitRef = useRef(handleSubmit)
  useEffect(() => {
    cancelRef.current = cancel
    submitRef.current = handleSubmit
  })
  useBottomZoneSlot(
    <FormActionBar
      mode={mode}
      pending={isPending}
      uploadingPhotos={submitPhase === 'uploading-photos'}
      onCancel={() => cancelRef.current()}
      onSubmit={() => void submitRef.current()}
    />,
    [mode, isPending, submitPhase],
  )

  return (
    <>
      <RecipeFormTopNav mode={mode} onCancel={cancel} />

      <main className="relative mx-auto max-w-3xl px-5 pb-40 pt-5 md:px-8 md:pt-7">
        <FormIntro mode={mode} groupName={groupQuery.data?.name} />

        {prefill && !bannerDismissed && (
          <ImportProvenanceBanner
            sourceUrl={prefill.sourceUrl}
            isPhotoImport={prefill.isPhotoImport}
            isChatImport={chatImportId != null}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* ── Grunddaten ─────────────────────────────────────── */}
          <FormCard
            title="Grunddaten"
            description="Titel und eine kurze Beschreibung, damit andere das Rezept wiedererkennen."
          >
            <Field htmlFor="recipe-title" label="Titel">
              <FormInput
                id="recipe-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
                placeholder="z.B. Mamas Apfelkuchen"
                required
              />
              <CharCounter value={title} max={TITLE_MAX} />
            </Field>

            <Field
              htmlFor="recipe-description"
              label="Beschreibung"
              optional
              className="mt-[14px]"
            >
              <FormTextarea
                id="recipe-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={DESC_MAX}
                placeholder="Ein Satz oder zwei zur Einordnung …"
              />
              <CharCounter value={description} max={DESC_MAX} />
            </Field>
          </FormCard>

          {/* ── Fotos ─────────────────────────────────────────── */}
          {/*
            UX1-PU: create mode uses the staged grid so the user can drop
            photos before the recipe exists. On submit, handleSubmit awaits
            createRecipe, then uploads the staged files sequentially against
            the newly-minted recipeId. Edit mode keeps the live grid so
            photo changes hit the backend immediately.
          */}
          {mode === 'edit' && initial ? (
            <FormCard
              title="Fotos"
              description="Bis zu 3 Bilder, je max. 5 MB. JPG, PNG oder WebP."
            >
              <PhotoUploadGrid recipeId={recipeId} photos={initial.photos} />
            </FormCard>
          ) : (
            <FormCard
              title="Fotos"
              description="Bis zu 3 Bilder, je max. 5 MB. JPG, PNG oder WebP. Werden beim Speichern hochgeladen."
            >
              {/* BUG-024 — pill is now a copy-only reminder; the
                  actual thumbnails sit in the grid below. We keep the
                  amber Sparkles pill (identity cue the import
                  happened) but drop the count since the user now
                  sees the tiles. Shown whenever at least one staged
                  photo is forwarding into the save payload. */}
              {mode === 'create' &&
                stagedPhotoIds &&
                stagedPhotoIds.length > 0 && (
                  <p
                    role="status"
                    data-testid="staged-photos-info"
                    className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--primary)/0.08)] px-3 py-1 text-[12.5px] font-medium text-[hsl(var(--primary-hover,var(--primary)))] ring-1 ring-[hsl(var(--primary)/0.25)]"
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    Diese Fotos werden beim Speichern angehängt.
                  </p>
                )}
              <PhotoUploadGrid
                mode="staged"
                files={stagedPhotos}
                onFilesChange={setStagedPhotos}
                preAttached={gridPreAttached}
                onRemovePreAttached={handleRemovePreAttached}
              />
            </FormCard>
          )}

          {/* ── Details ──────────────────────────────────────── */}
          <FormCard title="Details" description="Portionen, Zubereitungszeit, Schwierigkeit.">
            <div className="grid grid-cols-2 gap-3">
              <Field htmlFor="recipe-servings" label="Portionen">
                <FormInput
                  id="recipe-servings"
                  type="number"
                  min={1}
                  max={99}
                  value={defaultServings}
                  onChange={(e) =>
                    setDefaultServings(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Field>
              <Field htmlFor="recipe-prep" label="Dauer (Min)">
                <FormInput
                  id="recipe-prep"
                  type="number"
                  min={1}
                  max={600}
                  value={prepTime}
                  onChange={(e) => setPrepTime(e.target.value)}
                  placeholder="45"
                />
              </Field>
            </div>

            <Field
              htmlFor="recipe-difficulty"
              label="Schwierigkeit"
              className="mt-[14px]"
            >
              <DifficultyPills value={difficulty} onChange={setDifficulty} />
            </Field>

            <Field
              htmlFor="recipe-source"
              label="Quelle (URL)"
              optional
              className="mt-[14px]"
            >
              <FormInput
                id="recipe-source"
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://… — z.B. Foodblog oder Reel-Link"
              />
            </Field>
          </FormCard>

          {/* ── Zutaten ───────────────────────────────────────────
              COMP-2 — progressive disclosure. In default mode (single
              component with `label: null`) the render mirrors the pre-
              COMP-2 form exactly: flat ingredient list, flat step
              list, no component chrome. The "+ Komponente hinzufügen"
              button lives in the Zutaten header and flips the form
              into multi-component mode on click.
              Multi-component mode wraps each component in its own
              sub-card with a label input + delete-button header, and
              renders per-component ingredient + step lists inside a
              SINGLE DndContext each so cross-component drag-drop keeps
              working (1 drag boundary per kind, not a nested tree). */}
          {!isMultiComponentMode && components[0] ? (
            <>
              <FormCard
                title="Zutaten"
                description="Reihenfolge per Griff ziehen. Bei „nach Geschmack“ skalieren wir nicht mit."
              >
                <div className="mb-3 flex justify-end">
                  <AddComponentButton onClick={addComponent} />
                </div>
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleIngredientDragEnd}
                >
                  <SortableContext
                    items={components[0].ingredients.map((r) => r.key)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="flex flex-col gap-2">
                      {components[0].ingredients.map((row, index) => (
                        <SortableIngredientRow
                          key={row.key}
                          row={row}
                          index={index}
                          canRemove={components[0]!.ingredients.length > 1}
                          onUpdate={(rowIndex, updater) =>
                            updateIngredient(0, rowIndex, updater)
                          }
                          onRemove={() => removeIngredientRow(0, index)}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                </DndContext>
                <AddRowButton
                  onClick={() => addIngredientRow(0)}
                  label="Zutat hinzufügen"
                />
              </FormCard>

              <FormCard
                title="Zubereitung"
                description="Schrittweise. Reihenfolge per Griff umsortierbar."
              >
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleStepDragEnd}
                >
                  <SortableContext
                    items={components[0].steps.map((r) => r.key)}
                    strategy={verticalListSortingStrategy}
                  >
                    <ol className="flex flex-col gap-2">
                      {components[0].steps.map((row, index) => (
                        <SortableStepRow
                          key={row.key}
                          row={row}
                          index={index}
                          canRemove={components[0]!.steps.length > 1}
                          onChange={(content) => updateStep(0, index, content)}
                          onRemove={() => removeStepRow(0, index)}
                        />
                      ))}
                    </ol>
                  </SortableContext>
                </DndContext>
                <AddRowButton
                  onClick={() => addStepRow(0)}
                  label="Schritt hinzufügen"
                />
              </FormCard>
            </>
          ) : (
            <FormCard
              title="Komponenten"
              description="Zutaten und Schritte gruppiert — z.B. „Chipotle Sauce“ + „Hauptgericht“. Zutaten lassen sich per Drag-and-Drop zwischen Komponenten verschieben."
            >
              {/* One DndContext per kind so cross-component moves work
                  with a flat id-space but ingredient drags still can't
                  accidentally land in the step list. */}
              <DndContext
                sensors={dndSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleIngredientDragEnd}
              >
                <SortableContext
                  items={components.flatMap((c) => c.ingredients.map((r) => r.key))}
                  strategy={verticalListSortingStrategy}
                >
                  <DndContext
                    sensors={dndSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleStepDragEnd}
                  >
                    <SortableContext
                      items={components.flatMap((c) => c.steps.map((r) => r.key))}
                      strategy={verticalListSortingStrategy}
                    >
                      <ul className="flex flex-col gap-4">
                        {components.map((component, componentIndex) => (
                          <ComponentCard
                            key={component.key}
                            component={component}
                            componentIndex={componentIndex}
                            canDelete={components.length > 1}
                            onLabelChange={(label) =>
                              updateComponentLabel(componentIndex, label)
                            }
                            onDelete={() => removeComponent(componentIndex)}
                            onIngredientUpdate={(rowIndex, updater) =>
                              updateIngredient(componentIndex, rowIndex, updater)
                            }
                            onIngredientRemove={(rowIndex) =>
                              removeIngredientRow(componentIndex, rowIndex)
                            }
                            onIngredientAdd={() => addIngredientRow(componentIndex)}
                            onStepChange={(rowIndex, content) =>
                              updateStep(componentIndex, rowIndex, content)
                            }
                            onStepRemove={(rowIndex) =>
                              removeStepRow(componentIndex, rowIndex)
                            }
                            onStepAdd={() => addStepRow(componentIndex)}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </DndContext>
                </SortableContext>
              </DndContext>
              <div className="mt-4">
                <AddComponentButton onClick={addComponent} />
              </div>
            </FormCard>
          )}

          {/* ── Tags ──────────────────────────────────────────── */}
          <FormCard
            title="Tags"
            description="Tagge das Rezept für Filter und „Was kochen wir heute?“"
          >
            {tagsQuery.isLoading ? (
              <p className="text-xs text-[hsl(var(--muted-foreground))]">Lade Tags …</p>
            ) : (
              <div className="space-y-3.5">
                {CATEGORY_ORDER.filter((c) => tagsByCategory.has(c)).map((category, i) => (
                  <div
                    key={category}
                    className={cn(
                      i > 0 && 'border-t border-dashed border-border pt-3.5',
                    )}
                  >
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                      {CATEGORY_LABELS[category]}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(tagsByCategory.get(category) ?? []).map((tag) => (
                        <TagChip
                          key={tag.id}
                          label={tag.name}
                          selected={selectedTagIds.includes(tag.id)}
                          onToggle={() => toggleTag(tag.id)}
                        />
                      ))}
                      {category === 'Custom' && (
                        <CustomTagButton onClick={() => setCreateTagOpen(true)} />
                      )}
                    </div>
                  </div>
                ))}
                {!hasCustomCategory && (
                  <div className="border-t border-dashed border-border pt-3.5">
                    <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                      {CATEGORY_LABELS.Custom}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <CustomTagButton onClick={() => setCreateTagOpen(true)} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </FormCard>

          {/* P2-10 — read-only preview of the LLM-estimated per-portion
              nutrition. Only rendered in create mode when the import
              prefill carried an estimate; users can tweak the numbers
              on the DetailPage after the recipe is saved. */}
          {mode === 'create' && prefillNutrition && (
            <FormCard
              title="Nährwerte (geschätzt)"
              description="KI-Schätzung pro Portion. Nach dem Speichern kannst du die Werte auf der Rezept-Seite bearbeiten."
            >
              <dl
                className="grid grid-cols-2 gap-3 text-[14px]"
                aria-label="Geschätzte Nährwerte pro Portion"
              >
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                    Energie
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {prefillNutrition.kcal} kcal
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                    Eiweiß
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {prefillNutrition.proteinG} g
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                    Kohlenhydrate
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {prefillNutrition.carbsG} g
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
                    Fett
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {prefillNutrition.fatG} g
                  </dd>
                </div>
              </dl>
            </FormCard>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-[12px] bg-[hsl(var(--destructive)/0.1)] px-3 py-2 text-sm text-[hsl(var(--destructive))] ring-1 ring-[hsl(var(--destructive)/0.25)]"
            >
              {error}
            </p>
          )}

          {/* Hidden submit keeps Enter-to-submit working on inputs. The
              visible submit lives in the sticky action bar. */}
          <button type="submit" className="sr-only" aria-hidden="true" tabIndex={-1}>
            Rezept speichern
          </button>
        </form>

        {createTagOpen && (
          <CreateTagDialog groupId={groupId} onClose={() => setCreateTagOpen(false)} />
        )}

        {conflict.state && (
          <ConflictDialog<RecipeConflictShape>
            open={conflict.state.open}
            onClose={() => {
              setMergeEditorOpen(false)
              conflict.close()
            }}
            title="Konflikt im Rezept"
            subtitle="Deine Änderungen konkurrieren mit einer Änderung vom Server. Wähle, welche Version gelten soll."
            currentServer={conflict.state.serverCurrent}
            localPending={conflict.state.localPending}
            renderDiff={({ current, local }) => (
              <RecipeConflictBody
                current={current}
                local={local}
                mergeEditorOpen={mergeEditorOpen}
                onMergeChange={(merged) => {
                  mergedRef.current = merged
                }}
              />
            )}
            onKeepLocal={conflict.resolveKeepLocal}
            onKeepServer={conflict.resolveKeepServer}
            onManualMerge={async () => {
              if (!mergeEditorOpen) {
                // First click reveals the editor — user tweaks the
                // fields and clicks again to submit. We throw a
                // sentinel so the shared ConflictDialog's `handle`
                // helper treats this as "stay open" — it catches the
                // error and skips the auto-close.
                setMergeEditorOpen(true)
                throw new Error('open-merge-editor')
              }
              const merged = mergedRef.current ?? conflict.state!.localPending
              const prev = pendingPayloadRef.current
              if (!prev) return
              const body: UpdateRecipeRequest = {
                ...prev,
                title: merged.title,
                description: merged.description ?? undefined,
              }
              pendingPayloadRef.current = body
              setMergeEditorOpen(false)
              await updateMutation.mutateAsync({
                body,
                expectedVersion: conflict.state!.serverCurrent.version,
              })
              conflict.close()
              navigate(`/groups/${groupId}/recipes/${recipeId}`)
            }}
            isLoading={updateMutation.isPending}
            mergeLabel={mergeEditorOpen ? 'Zusammenführung übernehmen' : 'Manuell zusammenführen'}
          />
        )}
      </main>

      {/* BUG-036 — the form's action row lives in the Bottom-Zone slot
          now (see `useBottomZoneSlot(<FormActionBar … />)` above). */}
    </>
  )
}

// ── Card / field primitives ──────────────────────────────────────────

function FormCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-[18px] border border-border bg-card px-5 pb-5 pt-[18px] shadow-[0_1px_2px_rgba(28,25,23,0.04)]">
      <h2 className="mb-1 font-serif text-[20px] font-semibold tracking-[-0.005em] text-foreground">
        {title}
      </h2>
      <p className="mb-3.5 text-[13px] leading-[1.45] text-[hsl(var(--muted-foreground))]">
        {description}
      </p>
      {children}
    </section>
  )
}

function Field({
  htmlFor,
  label,
  optional,
  className,
  children,
}: {
  htmlFor: string
  label: string
  optional?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[0.01em] text-foreground"
      >
        {label}
        {optional && (
          <span className="text-[12px] font-normal text-[hsl(var(--muted-foreground))]">
            optional
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

function FormInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'placeholder:text-[hsl(var(--muted-foreground))]/80',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card',
        'disabled:cursor-not-allowed disabled:opacity-50',
        props.className,
      )}
    />
  )
}

function FormTextarea({
  ref,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: React.Ref<HTMLTextAreaElement>
}) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={cn(
        'min-h-[72px] w-full rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'placeholder:text-[hsl(var(--muted-foreground))]/80',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25 focus-visible:bg-card',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'resize-y',
        props.className,
      )}
    />
  )
}

function FormSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'w-full appearance-none rounded-[12px] border border-[hsl(var(--input))] bg-card px-[13px] py-[11px] pr-9 text-base leading-[1.4] text-foreground transition-[border-color,box-shadow,background-color] duration-150',
        'bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2714%27%20height%3D%2714%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%2357534e%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpolyline%20points%3D%276%209%2012%2015%2018%209%27/%3E%3C/svg%3E")] bg-[right_12px_center] bg-no-repeat',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
        props.className,
      )}
    />
  )
}

// ── Add-row + tag chips ──────────────────────────────────────────────

function AddRowButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[12px] border border-dashed border-[hsl(var(--input))] bg-transparent px-4 py-[11px] text-[14px] font-medium text-[hsl(var(--muted-foreground))]',
        'transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary',
      )}
    >
      <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
      {label}
    </button>
  )
}

function TagChip({
  label,
  selected,
  onToggle,
}: {
  label: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-[5px] text-[13px] transition-colors',
        selected
          ? 'border-primary bg-primary text-[hsl(var(--primary-foreground))]'
          : 'border-[hsl(var(--input))] bg-transparent text-[hsl(var(--muted-foreground))] hover:border-primary hover:text-primary',
      )}
    >
      {label}
    </button>
  )
}

function CustomTagButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--input))] bg-transparent px-2.5 py-[5px] text-[13px] text-[hsl(var(--muted-foreground))] transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary"
    >
      <Plus className="h-3 w-3" aria-hidden="true" />
      Neuen Tag erstellen
    </button>
  )
}

// ── Ingredient row ───────────────────────────────────────────────────

/**
 * COMP-2 — "+ Komponente hinzufügen" button. Shared between the
 * Zutaten-header (single-default mode) and the Komponenten-footer
 * (multi-component mode). Styled like `AddRowButton` but opinionated
 * about its icon + copy.
 */
function AddComponentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-dashed border-[hsl(var(--primary)/0.35)] bg-[hsl(var(--primary)/0.06)] px-3.5 py-[7px] text-[13px] font-semibold text-[hsl(var(--primary-hover,var(--primary)))]',
        'transition-colors hover:border-primary hover:bg-[hsl(var(--primary)/0.12)]',
      )}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      Komponente hinzufügen
    </button>
  )
}

/**
 * COMP-2 — one component's sub-card in multi-component mode. Renders:
 *   - editable label input (capped at {@link COMPONENT_LABEL_MAX}),
 *   - delete button (disabled when it's the last component),
 *   - per-component ingredient list (scoped SortableContext so intra-
 *     component reorder stays local),
 *   - per-component step list (same scoping),
 *   - add-row buttons for ingredients + steps.
 *
 * The surrounding parent owns the DndContext(s) so cross-component
 * drag-drop continues to work — the SortableContext here just narrows
 * the render.
 */
function ComponentCard({
  component,
  componentIndex,
  canDelete,
  onLabelChange,
  onDelete,
  onIngredientUpdate,
  onIngredientRemove,
  onIngredientAdd,
  onStepChange,
  onStepRemove,
  onStepAdd,
}: {
  component: ComponentRow
  componentIndex: number
  canDelete: boolean
  onLabelChange: (label: string) => void
  onDelete: () => void
  onIngredientUpdate: (
    rowIndex: number,
    updater: (row: IngredientRow) => IngredientRow,
  ) => void
  onIngredientRemove: (rowIndex: number) => void
  onIngredientAdd: () => void
  onStepChange: (rowIndex: number, content: string) => void
  onStepRemove: (rowIndex: number) => void
  onStepAdd: () => void
}) {
  const labelId = `component-label-${component.key}`
  return (
    <li
      data-testid={`component-card-${componentIndex}`}
      className="rounded-[14px] border border-border bg-[hsl(var(--muted)/0.35)] p-4"
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="flex-1">
          <label
            htmlFor={labelId}
            className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]"
          >
            Komponenten-Name
          </label>
          <input
            id={labelId}
            data-testid={`component-label-input-${componentIndex}`}
            type="text"
            value={component.label ?? ''}
            onChange={(e) => onLabelChange(e.target.value)}
            maxLength={COMPONENT_LABEL_MAX}
            placeholder="z.B. Chipotle Sauce oder Hauptgericht"
            aria-label={`Komponente ${componentIndex + 1} Name`}
            className={cn(
              'w-full rounded-[10px] border border-[hsl(var(--input))] bg-background px-3 py-2 text-[15px] font-semibold text-foreground',
              'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-ring/25',
            )}
          />
        </div>
        <button
          type="button"
          data-testid={`component-delete-${componentIndex}`}
          onClick={onDelete}
          disabled={!canDelete}
          aria-label={`Komponente ${componentIndex + 1} entfernen`}
          className={cn(
            'mt-[22px] grid h-9 w-9 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] hover:text-[hsl(var(--destructive))]',
            !canDelete &&
              'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[hsl(var(--muted-foreground))]',
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mb-3">
        <h4 className="mb-2 text-[12px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
          Zutaten
        </h4>
        <SortableContext
          items={component.ingredients.map((r) => r.key)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-2">
            {component.ingredients.map((row, index) => (
              <SortableIngredientRow
                key={row.key}
                row={row}
                index={index}
                canRemove={component.ingredients.length > 1}
                onUpdate={(rowIndex, updater) =>
                  onIngredientUpdate(rowIndex, updater)
                }
                onRemove={() => onIngredientRemove(index)}
              />
            ))}
          </ul>
        </SortableContext>
        <AddRowButton onClick={onIngredientAdd} label="Zutat hinzufügen" />
      </div>

      <div>
        <h4 className="mb-2 text-[12px] font-bold uppercase tracking-[0.08em] text-[hsl(var(--muted-foreground))]">
          Zubereitung
        </h4>
        <SortableContext
          items={component.steps.map((r) => r.key)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="flex flex-col gap-2">
            {component.steps.map((row, index) => (
              <SortableStepRow
                key={row.key}
                row={row}
                index={index}
                canRemove={component.steps.length > 1}
                onChange={(content) => onStepChange(index, content)}
                onRemove={() => onStepRemove(index)}
              />
            ))}
          </ol>
        </SortableContext>
        <AddRowButton onClick={onStepAdd} label="Schritt hinzufügen" />
      </div>
    </li>
  )
}

/**
 * Sortable ingredient row — preserves the S3 drag-drop wiring:
 * the drag-handle button carries the @dnd-kit listeners/attributes,
 * including the keyboard-sensor coordinate getter so Space + ArrowUp/Down
 * reorder rows without a mouse.
 *
 * Visual shell mirrors `.drag-row` + `.ing-body` in the mockup:
 *   [handle] [qty | unit-select | name ] [scalable | X]
 *   [                 note-row                      ]
 *
 * `scalable` auto-disables whenever `quantity` is blank because the
 * scaler math (scaleIngredients) throws on null/0 quantities.
 */
function SortableIngredientRow({
  row,
  index,
  canRemove,
  onUpdate,
  onRemove,
}: {
  row: IngredientRow
  index: number
  canRemove: boolean
  onUpdate: (index: number, updater: (row: IngredientRow) => IngredientRow) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.key })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  }
  const hasQty = row.quantity.trim().length > 0
  const scalableEffective = hasQty && row.scalable

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'grid grid-cols-[28px_1fr_auto] items-start gap-2 rounded-[12px] border border-border bg-[hsl(var(--muted))] py-2.5 pl-1 pr-2.5 transition-colors',
        isDragging && 'border-primary bg-[hsl(var(--primary)/0.08)] shadow-[0_8px_24px_-8px_rgba(146,64,14,0.14)]',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`ingredient-drag-handle-${index}`}
        aria-label="Zutat verschieben"
        className="grid h-10 min-h-[40px] w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {/*
        BUG-029 — on screens below Tailwind's md breakpoint (<768px) the
        old 3-column grid `grid-cols-[92px_96px_1fr]` left the name input
        with only ~37px on a 375px iPhone SE viewport (qty 92 + unit 96 +
        gaps + outer chrome ate the row). We now stack on mobile — name
        takes a full-width row and qty+unit sit in a sub-row below — and
        restore the original 3-column grid at md+. The `md:contents`
        wrapper dissolves at md+ so qty and unit drop directly into grid
        cells 1 and 2 while the name occupies cell 3 via `md:order-3`.
      */}
      <div className="flex flex-col gap-1.5 md:grid md:grid-cols-[92px_96px_1fr] md:items-start md:gap-1.5">
        <FormInput
          type="text"
          value={row.name}
          onChange={(e) => onUpdate(index, (r) => ({ ...r, name: e.target.value }))}
          placeholder="Zutat"
          aria-label={`Zutat ${index + 1} Name`}
          className="py-2 text-base md:order-3"
        />
        <div className="flex gap-1.5 md:contents">
          <FormInput
            type="text"
            inputMode="decimal"
            value={row.quantity}
            onChange={(e) => onUpdate(index, (r) => ({ ...r, quantity: e.target.value }))}
            placeholder="Menge"
            aria-label={`Zutat ${index + 1} Menge`}
            className="w-[96px] py-2 text-right text-base md:order-1 md:w-auto"
          />
          <FormSelect
            value={row.unit}
            onChange={(e) => onUpdate(index, (r) => ({ ...r, unit: e.target.value }))}
            aria-label={`Zutat ${index + 1} Einheit`}
            className="flex-1 py-2 text-base md:order-2 md:flex-none"
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </FormSelect>
        </div>
        {row.confidence &&
          (row.confidence === 'missing' ||
            row.confidence === 'handwritten_uncertain') && (
            <div className="md:order-4 md:col-span-3 md:mt-1">
              <ConfidenceBadge confidence={row.confidence} />
            </div>
          )}
        <div className="md:order-5 md:col-span-3 md:mt-1">
          <FormInput
            type="text"
            value={row.note}
            onChange={(e) => onUpdate(index, (r) => ({ ...r, note: e.target.value }))}
            placeholder="Notiz (optional), z.B. „fein gehackt“"
            aria-label={`Zutat ${index + 1} Notiz`}
            className="py-1.5 text-base"
          />
        </div>
      </div>

      <div className="flex flex-col items-center gap-1.5 pt-1">
        <button
          type="button"
          onClick={() =>
            onUpdate(index, (r) => ({ ...r, scalable: !r.scalable }))
          }
          disabled={!hasQty}
          aria-pressed={scalableEffective}
          aria-label={`Zutat ${index + 1} skalieren`}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
            scalableEffective
              ? 'border-transparent bg-[hsl(var(--secondary))] text-[hsl(var(--primary-hover,var(--primary)))]'
              : 'border-[hsl(var(--input))] bg-transparent text-[hsl(var(--muted-foreground))]',
            !hasQty && 'cursor-not-allowed opacity-60',
            hasQty && 'hover:border-[hsl(var(--primary-hover,var(--primary)))]',
          )}
        >
          {scalableEffective ? 'skalierbar' : 'nicht skalieren'}
        </button>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Zutat entfernen"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] hover:text-[hsl(var(--destructive))]',
            !canRemove && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[hsl(var(--muted-foreground))]',
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

// ── Step row ─────────────────────────────────────────────────────────

/**
 * Sortable step row — same pattern as SortableIngredientRow. The drag
 * handle button carries the @dnd-kit listeners so Space + ArrowUp/Down
 * reorder without a mouse.
 *
 * Visual shell mirrors `.drag-row` + `.step-body` in the mockup:
 *   [handle] [step-num serif avatar + "Schritt N" label + textarea] [X]
 */
function SortableStepRow({
  row,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  row: StepRow
  index: number
  canRemove: boolean
  onChange: (content: string) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.key })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  }
  // Per-step preview toggle — local to the row so flipping one step
  // doesn't re-render the other rows' textareas.
  const [previewMode, setPreviewMode] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd+B on macOS, Ctrl+B on Windows / Linux. Same for italic.
    const isMod = event.metaKey || event.ctrlKey
    if (!isMod) return
    if (event.key === 'b' || event.key === 'B') {
      event.preventDefault()
      applyShortcutWrap('**', '**')
    } else if (event.key === 'i' || event.key === 'I') {
      event.preventDefault()
      applyShortcutWrap('*', '*')
    }
  }

  function applyShortcutWrap(before: string, after: string) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart ?? 0
    const end = ta.selectionEnd ?? 0
    const result = wrapSelection(row.content, start, end, before, after)
    onChange(result.nextValue)
    // The textarea is controlled — set the selection in a microtask so
    // React's commit has landed the new value before we re-range.
    queueMicrotask(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      node.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd)
    })
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'grid grid-cols-[28px_1fr_auto] items-start gap-2 rounded-[12px] border border-border bg-[hsl(var(--muted))] py-2.5 pl-1 pr-2.5 transition-colors',
        isDragging && 'border-primary bg-[hsl(var(--primary)/0.08)] shadow-[0_8px_24px_-8px_rgba(146,64,14,0.14)]',
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        data-testid={`step-drag-handle-${index}`}
        aria-label="Schritt verschieben"
        className="grid h-10 min-h-[40px] w-7 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--primary)/0.08)] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:cursor-grabbing"
        style={{ touchAction: 'none', cursor: 'grab' }}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <div
            aria-hidden="true"
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-primary font-serif text-[13px] font-bold text-[hsl(var(--primary-foreground))]"
          >
            {index + 1}
          </div>
          <span className="text-[13px] font-semibold text-[hsl(var(--muted-foreground))]">
            Schritt {index + 1}
          </span>
          {row.confidence === 'handwritten_uncertain' && (
            <ConfidenceBadge confidence={row.confidence} />
          )}
        </div>
        <StepMarkdownToolbar
          value={row.content}
          onChange={onChange}
          textareaRef={textareaRef}
          previewMode={previewMode}
          onTogglePreview={() => setPreviewMode((p) => !p)}
        />
        {previewMode ? (
          <div
            data-testid={`step-preview-${index}`}
            aria-label={`Schritt ${index + 1} Vorschau`}
            className="min-h-[52px] rounded-[12px] border border-[hsl(var(--input))] bg-background px-[13px] py-[11px] text-base leading-[1.4] text-foreground [&_strong]:font-semibold [&_strong]:text-[hsl(var(--primary-hover,var(--primary)))]"
          >
            {row.content.trim().length === 0 ? (
              <span className="text-[hsl(var(--muted-foreground))]">
                Noch kein Inhalt.
              </span>
            ) : (
              renderInlineMarkdown(row.content)
            )}
          </div>
        ) : (
          <FormTextarea
            ref={textareaRef}
            value={row.content}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder="Was wird in diesem Schritt gemacht?"
            aria-label={`Schritt ${index + 1}`}
            maxLength={5000}
            className="min-h-[52px] text-base"
          />
        )}
      </div>

      <div className="flex items-start pt-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label="Schritt entfernen"
          className={cn(
            'grid h-6 w-6 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--destructive)/0.08)] hover:text-[hsl(var(--destructive))]',
            !canRemove && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-[hsl(var(--muted-foreground))]',
          )}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}

// ── P2-7 import helpers ──────────────────────────────────────────────

/**
 * Banner shown above the form when the page was opened with an
 * `?importId=…` query. It advertises the AI provenance + truncates a
 * long URL to 40 chars so the layout stays stable; the full URL is
 * available on hover via the native `title` tooltip. The banner is
 * dismissible — the dismissal only hides the chrome, the prefilled
 * form keeps its data.
 *
 * Three provenance variants share the same chrome:
 *   - URL import (default): "AI-Vorschlag aus <url>".
 *   - Photo import (`isPhotoImport === true`): "AI-Vorschlag aus deinen
 *     Fotos" — the `photos://upload` sentinel never reaches the user.
 *   - Chat import (P2-9, `isChatImport === true`): "AI-Vorschlag aus
 *     dem Chat" — chat has no source URL at all, just the dialogue.
 */
function ImportProvenanceBanner({
  sourceUrl,
  isPhotoImport,
  isChatImport,
  onDismiss,
}: {
  sourceUrl: string
  isPhotoImport: boolean
  isChatImport: boolean
  onDismiss: () => void
}) {
  const displayUrl =
    sourceUrl.length > 40 ? `${sourceUrl.slice(0, 37)}…` : sourceUrl
  return (
    <section
      role="region"
      aria-label="KI-Import-Hinweis"
      className="mb-5 flex items-start gap-3 rounded-[14px] border border-[hsl(var(--primary)/0.3)] bg-[hsl(var(--primary)/0.08)] px-4 py-3 text-[14px] leading-[1.5]"
    >
      <Sparkles
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 text-foreground">
        {isChatImport ? (
          <>
            AI-Vorschlag aus{' '}
            <span className="font-medium text-primary">dem Chat</span>. Bitte
            durchsehen, bevor du speicherst.
          </>
        ) : isPhotoImport ? (
          <>
            AI-Vorschlag aus{' '}
            <span className="font-medium text-primary">deinen Fotos</span>.
            Bitte durchsehen, bevor du speicherst.
          </>
        ) : (
          <>
            AI-Vorschlag aus{' '}
            <span
              className="break-all font-medium text-primary"
              title={sourceUrl}
            >
              {displayUrl}
            </span>
            . Bitte durchsehen, bevor du speicherst.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Hinweis ausblenden"
        className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </section>
  )
}

/**
 * Inline confidence badge for an ingredient/step row. Renders different
 * copy / tints for the two review-worthy confidence levels and hides
 * everything else so the chrome stays calm.
 *
 * Tokens in use:
 *   - "missing" → yellow-ish warning tint (destructive token would be
 *     too loud; we want "please double-check this" not "error").
 *   - "handwritten_uncertain" → orange tint distinct from missing,
 *     reserved for the Photo/Handschrift pipeline that lands in P2-8.
 *
 * Anything else (high / medium / low / undefined) renders nothing so
 * manually-created rows stay visually identical to before P2-7.
 */
export function ConfidenceBadge({
  confidence,
}: {
  confidence?: IngredientConfidenceLevel | StepConfidenceLevel
}) {
  if (confidence === 'missing') {
    return (
      <span
        className="inline-flex items-center rounded-full border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.14)] px-2 py-0.5 text-[11px] font-semibold text-[hsl(var(--warning-foreground))]"
        aria-label="Menge fehlt"
      >
        Menge fehlt
      </span>
    )
  }
  if (confidence === 'handwritten_uncertain') {
    return (
      <span
        className="inline-flex items-center rounded-full border border-[hsl(var(--caution)/0.35)] bg-[hsl(var(--caution)/0.14)] px-2 py-0.5 text-[11px] font-semibold text-[hsl(var(--caution-foreground))]"
        aria-label="Handschrift prüfen"
      >
        Handschrift prüfen
      </span>
    )
  }
  return null
}
