import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateRecipeRequest,
  ForkRecipeRequest,
  ImportEnqueueResponse,
  NutritionEstimate,
  RecipeDetailDto,
  RecipeListSort,
  RecipeOriginImportResponse,
  RecipeRevisionDetail,
  RecipeRevisionSummary,
  RecipeSummaryListDto,
  RecipeTranslationPayload,
  RecipeTranslationResponse,
  TagDto,
  UpdateRecipeRequest,
  UploadPhotoResponse,
} from '@familien-kochbuch/shared'
import { applyTranslation } from './applyTranslation'
import { DEFAULT_RECIPE_LIST_SORT } from '@familien-kochbuch/shared'
import {
  createRecipe,
  deleteRecipe,
  deleteRecipePhoto,
  fetchGroupRecipes,
  fetchGroupTags,
  fetchRecipe,
  fetchRecipeOriginImport,
  forkRecipe,
  markRecipeAsCooked,
  patchRecipeNutrition,
  reimportRecipe,
  swapRecipeCover,
  translateRecipe,
  updateRecipe,
  uploadRecipePhoto,
} from './recipesApi'
import { fetchRecipeRevision, fetchRecipeRevisions } from './revisionsApi'
import { recipeQueryKeys } from './queryKeys'
import { importQueryKeys } from '@/features/imports/hooks'
import { groupQueryKeys } from '@/features/groups/queryKeys'
import { buildIfMatch } from '@/features/_shared/ifMatch'

/**
 * PAGE-1 — paginated + sorted slice of a group's recipes.
 *
 * Matches backend PAGE-0 contract:
 *   `GET /api/groups/:groupId/recipes?page=1&pageSize=24&sort=updated_desc`
 *   → `{ items, page, pageSize, total, hasNextPage, hasPrevPage }`.
 *
 * Query key shape: `['recipes', 'group', groupId, page, sort]` when the
 * caller sticks with the default pageSize (24), so pagination state
 * round-trips the cache cleanly. `pageSize` is only appended to the key
 * when it differs from the default — low-frequency consumers like the
 * mealplan picker (pageSize=100) get their own cache bucket without
 * inflating the common grid consumer's key.
 *
 * The hook accepts an options bag so call-sites read self-documenting
 * (no mystery positional `undefined`s). `sort` defaults to
 * `updated_desc`, matching the backend. Unknown sorts surface as a
 * 400 `invalid_sort` via the standard list-load-error toast — one of
 * `cook_count_desc` / `rating_desc` may be cut on the backend depending
 * on column availability.
 */
export function useRecipes(
  groupId: string | undefined,
  options: { page?: number; pageSize?: number; sort?: RecipeListSort } = {},
) {
  const page = options.page ?? 1
  const sort = options.sort ?? DEFAULT_RECIPE_LIST_SORT
  const pageSize = options.pageSize
  return useQuery<RecipeSummaryListDto>({
    queryKey: groupId
      ? recipeQueryKeys.forGroup(groupId, page, sort, pageSize)
      : ['recipes', 'group', 'disabled'],
    queryFn: () => fetchGroupRecipes(groupId!, { page, pageSize, sort }),
    enabled: !!groupId,
  })
}

/** Full recipe detail, including ingredients, steps, tags. */
export function useRecipe(id: string | undefined) {
  return useQuery<RecipeDetailDto>({
    queryKey: id ? recipeQueryKeys.detail(id) : ['recipes', 'detail', 'disabled'],
    queryFn: () => fetchRecipe(id!),
    enabled: !!id,
  })
}

/** Global + group-scoped tags for a given group. */
export function useGroupTags(groupId: string | undefined) {
  return useQuery<TagDto[]>({
    queryKey: groupId ? recipeQueryKeys.tagsForGroup(groupId) : ['tags', 'group', 'disabled'],
    queryFn: () => fetchGroupTags(groupId!),
    enabled: !!groupId,
  })
}

// ── Mutations ───────────────────────────────────────────────────────

export function useCreateRecipe(groupId: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, CreateRecipeRequest>({
    mutationFn: (body) => createRecipe(groupId, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      void client.invalidateQueries({ queryKey: groupQueryKeys.detail(groupId) })
    },
  })
}

/**
 * OFF4 — `useUpdateRecipe` reads the cached recipe's `version` and
 * sends it as `If-Match: W/"<id>-<version>"` so the backend can reject
 * stale writes with a 409. Callers can also override the
 * expected-version (plan-mandated Keep-Local retry path: the conflict
 * resolver bumps to the server's current version + re-dispatches the
 * same patch).
 */
export function useUpdateRecipe(id: string, groupId?: string) {
  const client = useQueryClient()
  return useMutation<
    RecipeDetailDto,
    Error,
    UpdateRecipeRequest | { body: UpdateRecipeRequest; expectedVersion: number }
  >({
    mutationFn: (input) => {
      // Two call shapes so existing callers (the form) don't change:
      // pass a plain UpdateRecipeRequest → the hook reads `version`
      // from cache. Resolver retries pass `{ body, expectedVersion }`
      // to force a specific If-Match after a 409.
      const isWrapped = typeof input === 'object' && input !== null && 'body' in input && 'expectedVersion' in input
      const body = isWrapped ? input.body : input
      const expected = isWrapped
        ? input.expectedVersion
        : client.getQueryData<RecipeDetailDto>(recipeQueryKeys.detail(id))?.version
      const ifMatch =
        typeof expected === 'number' ? buildIfMatch(id, expected) : undefined
      return updateRecipe(id, body, { ifMatch })
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
      // S6: any successful PUT may have appended a new revision; refresh
      // the history so the panel re-renders without a manual reload.
      void client.invalidateQueries({ queryKey: recipeQueryKeys.revisions(id) })
      if (groupId) {
        void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      }
    },
  })
}

export function useDeleteRecipe(groupId?: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: deleteRecipe,
    onSuccess: (_data, id) => {
      void client.removeQueries({ queryKey: recipeQueryKeys.detail(id) })
      if (groupId) {
        void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', groupId] })
      }
    },
  })
}

export function useUploadRecipePhoto(id: string) {
  const client = useQueryClient()
  return useMutation<UploadPhotoResponse, Error, File>({
    mutationFn: (file) => uploadRecipePhoto(id, file),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
    },
  })
}

export function useForkRecipe(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, ForkRecipeRequest>({
    mutationFn: (body) => forkRecipe(id, body),
    onSuccess: (data) => {
      // The new recipe lives in another group; refresh that group's list
      // and the new recipe's detail cache.
      void client.invalidateQueries({ queryKey: [...recipeQueryKeys.all, 'group', data.groupId] })
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(data.id) })
    },
  })
}

/**
 * DS5 "Jetzt gekocht" mutation — POSTs `/api/recipes/{id}/cook` and
 * refreshes the recipe detail + any group list the recipe belongs to so
 * the recency sort picks up the new `lastCookedAt`. The updated detail
 * is seeded straight into the cache to avoid an extra round-trip.
 */
export function useMarkAsCooked(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, void>({
    mutationFn: () => markRecipeAsCooked(id),
    onSuccess: (detail) => {
      client.setQueryData(recipeQueryKeys.detail(id), detail)
      void client.invalidateQueries({
        queryKey: [...recipeQueryKeys.all, 'group', detail.groupId],
      })
      // Recency sort on Home may now differ — invalidate the
      // "recently cooked" query family so it re-runs.
      void client.invalidateQueries({ queryKey: ['recentlyCooked'] })
    },
  })
}

/**
 * P2-10 — PATCH the per-portion nutrition estimate on a recipe. `null`
 * body clears the stored estimate, a populated object replaces it. The
 * refreshed detail DTO is written straight into the TanStack cache so
 * the UI reflects the edit without a follow-up GET.
 */
export function useUpdateRecipeNutrition(id: string) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, NutritionEstimate | null>({
    mutationFn: (body) => patchRecipeNutrition(id, body),
    onSuccess: (detail) => {
      client.setQueryData(recipeQueryKeys.detail(id), detail)
    },
  })
}

export function useRemoveRecipePhoto(id: string) {
  const client = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: (url) => deleteRecipePhoto(id, url),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: recipeQueryKeys.detail(id) })
    },
  })
}

// ── COVER-0 Slice E: Cover swap + origin-import lookup ────────────

/**
 * COVER-0 Slice E — lazy query for the recipe's originating
 * `RecipeImport.id`. Drives the "Cover ändern" button on the detail
 * page: the button only mounts when this query resolves to a non-null
 * id AND the candidates-query (fired inside the modal) returns at
 * least one un-promoted candidate.
 *
 * Returns `null` on the server's 404 (manual recipe / every candidate
 * consumed + not a reimport target). Every other error surfaces as
 * `query.isError` so the detail page can hide the button and log.
 */
export function useRecipeOriginImport(
  recipeId: string | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = (options?.enabled ?? true) && !!recipeId
  return useQuery<RecipeOriginImportResponse | null>({
    queryKey: recipeId
      ? recipeQueryKeys.originImport(recipeId)
      : ['recipes', 'origin-import', 'disabled'],
    queryFn: () => fetchRecipeOriginImport(recipeId!),
    enabled,
    // The linkage is effectively immutable for the recipe's lifetime
    // (it flips to null only when the sweep reaps the last candidate
    // row, after which the candidates endpoint 410s anyway). 5-minute
    // staleness mirrors the candidates query so both refresh on the
    // same cadence.
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * COVER-0 Slice E — mutation wrapper around
 * `POST /api/recipes/:id/cover`.
 *
 * On success:
 *   - seeds the refreshed `RecipeDetailDto` straight into the detail
 *     cache so the hero image re-renders instantly,
 *   - invalidates the candidates query so the modal reflects the new
 *     "which candidates are still un-promoted" truth.
 *
 * The mutation deliberately does NOT surface 410 specially — the 410
 * path is "the candidates list is gone, so the modal shouldn't even be
 * open". Callers that want a 410-specific UX read it off the
 * candidates query's `isError` / `error.code` in the modal.
 */
export function useSwapRecipeCover(recipeId: string, importId?: string | null) {
  const client = useQueryClient()
  return useMutation<RecipeDetailDto, Error, string>({
    mutationFn: (stagedPhotoId) =>
      swapRecipeCover(recipeId, { stagedPhotoId }),
    onSuccess: (detail) => {
      client.setQueryData(recipeQueryKeys.detail(recipeId), detail)
      if (importId) {
        void client.invalidateQueries({
          queryKey: importQueryKeys.candidates(importId),
        })
      }
    },
  })
}

// ── REIMPORT-1: Reimport an existing recipe from its saved source URL ─

/**
 * REIMPORT-1 — fire a fresh extractor run against the recipe's saved
 * `sourceUrl`. The mutation accepts the caller's last-known `version`
 * as its `mutate` argument so the built `If-Match` header carries the
 * correct ETag (`W/"{id}-{version}"`); passing a stale version yields
 * a typed `VersionMismatchError` for the conflict-resolver UX.
 *
 * Returns `{ importId }` so the caller can navigate to
 * `/rezepte/import/{importId}` — the existing `ImportProgressPage` owns
 * the polling + terminal-state redirect, branching on the wire's
 * `targetRecipeId` to hop back to the recipe detail page on Done. On
 * Done, the progress page itself invalidates the recipe detail query,
 * so this hook has no post-success cache work to do.
 */
export function useReimportRecipe(recipeId: string) {
  return useMutation<ImportEnqueueResponse, Error, number>({
    mutationFn: (currentVersion) =>
      reimportRecipe(recipeId, {
        ifMatch: buildIfMatch(recipeId, currentVersion),
      }),
  })
}

// ── S6: Version history ────────────────────────────────────────────────

/** Last 5 revision summaries for a recipe. */
export function useRecipeRevisions(recipeId: string | undefined) {
  return useQuery<RecipeRevisionSummary[]>({
    queryKey: recipeId
      ? recipeQueryKeys.revisions(recipeId)
      : ['recipes', 'revisions', 'disabled'],
    queryFn: () => fetchRecipeRevisions(recipeId!),
    enabled: !!recipeId,
  })
}

/** Full snapshot for a single revision — fetched on demand when the
 *  diff modal opens. */
export function useRecipeRevision(
  recipeId: string | undefined,
  revisionId: string | undefined,
) {
  return useQuery<RecipeRevisionDetail>({
    queryKey: recipeId && revisionId
      ? recipeQueryKeys.revision(recipeId, revisionId)
      : ['recipes', 'revisions', 'detail', 'disabled'],
    queryFn: () => fetchRecipeRevision(recipeId!, revisionId!),
    enabled: !!(recipeId && revisionId),
  })
}

// ── LANG-2: Translate a recipe on demand ───────────────────────────────

/**
 * LANG-2 — `POST /api/recipes/:id/translate?lang=de|en[&force=true]`.
 *
 * The hook is a TanStack-Query `useMutation` keyed by
 * `recipeQueryKeys.translation(recipeId, lang)`. The mutation argument
 * carries the `force` flag so the same hook drives both the initial
 * translate click and the "Aktualisieren" link on the stale-banner.
 *
 * Server caches by `(recipeId, language)`; the success handler primes
 * the local query cache so the next render reads the payload directly
 * via `queryClient.getQueryData(translationKey)` without an extra
 * round-trip. Toggling back to original on the detail page never
 * unloads this cache entry, so a subsequent toggle-to-translated is
 * instant.
 */
export function useTranslateRecipe(recipeId: string, lang: string) {
  const client = useQueryClient()
  return useMutation<RecipeTranslationResponse, Error, { force?: boolean } | void>({
    mutationKey: recipeQueryKeys.translation(recipeId, lang),
    mutationFn: (variables) =>
      translateRecipe(recipeId, lang, { force: variables?.force ?? false }),
    onSuccess: (response) => {
      client.setQueryData(
        recipeQueryKeys.translation(recipeId, lang),
        response,
      )
    },
  })
}

/**
 * Read-only accessor for an already-translated recipe payload. Returns
 * `undefined` until the corresponding `useTranslateRecipe` mutation has
 * resolved at least once for this `(recipeId, lang)` pair. Used by
 * `RecipeDetailPage` to avoid re-firing the mutation on a remount when
 * the translation is already cached this session.
 */
export function useCachedTranslation(recipeId: string, lang: string) {
  const client = useQueryClient()
  return client.getQueryData<RecipeTranslationResponse>(
    recipeQueryKeys.translation(recipeId, lang),
  )
}

/**
 * LANG-2-FU-1 — view-respecting recipe accessor for surfaces other than
 * the detail page (Cook-Now today, PDF / Print / Share when those land).
 *
 * Pulls the recipe via `useRecipe`, looks up the cached translation for
 * the active UI language (no implicit re-fetch — deep-link-safe), and
 * merges the two via `applyTranslation` when:
 *
 *   - the recipe's `sourceLanguage` differs from the UI lang AND
 *   - a cached translation exists.
 *
 * Returns `recipe` unchanged otherwise — callers don't have to branch
 * for the no-translation case. The `isStaleTranslation` flag mirrors
 * the `RecipeTranslationResponse.isStale` field and is true only when a
 * translation is actively rendered AND flagged stale by the backend
 * (recipe was edited after the last translate).
 *
 * Edge-case caveat: the detail page's per-session `viewState` toggle is
 * NOT round-tripped here. If the user translates → toggles back to
 * "Original anzeigen" → opens Cook-Now, this hook still shows the
 * cached translation (the cache wasn't evicted by the toggle). The
 * audit finding the FU-1 slice addresses is the inverse direction
 * (translated → Cook-Now showed German). A future Route-State or
 * shared-store extension can plug the reverse-toggle hole if it shows
 * up in user feedback.
 */
export function useViewLanguageRecipe(recipeId: string) {
  const detail = useRecipe(recipeId)
  const { i18n } = useTranslation()
  const uiLang = i18n.language?.startsWith('de') ? 'de' : 'en'
  const sourceLanguage = detail.data?.sourceLanguage ?? 'de'
  const cachedTranslation = useCachedTranslation(recipeId, uiLang)
  const translatedPayload = useMemo<RecipeTranslationPayload | null>(() => {
    if (!cachedTranslation) return null
    if (sourceLanguage === uiLang) return null
    try {
      return JSON.parse(
        cachedTranslation.translatedPayload,
      ) as RecipeTranslationPayload
    } catch {
      return null
    }
  }, [cachedTranslation, sourceLanguage, uiLang])
  const recipe = useMemo<RecipeDetailDto | null>(() => {
    if (!detail.data) return null
    if (translatedPayload) return applyTranslation(detail.data, translatedPayload)
    return detail.data
  }, [detail.data, translatedPayload])
  return {
    recipe,
    isLoading: detail.isLoading,
    isError: detail.isError,
    isStaleTranslation:
      !!translatedPayload && !!cachedTranslation?.isStale,
  }
}
