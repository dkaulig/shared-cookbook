import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddSlotRequest,
  CreateMealPlanRequest,
  MealPlanDto,
  MealPlanSlotDto,
  PatchSlotRequest,
} from '@shared-cookbook/shared'
import {
  MealPlanApiError,
  addSlot,
  copyFromWeek,
  createMealPlan,
  deleteSlot,
  fetchMealPlan,
  patchSlot,
} from './mealPlanApi'
import { buildIfMatch } from '@/features/_shared/ifMatch'

/**
 * Centralised TanStack-Query key factory for the meal-planning cache.
 * Kept exported so tests and the future P3-8 SignalR invalidator can
 * surgically poke the same entries the UI reads.
 */
export const mealPlanQueryKeys = {
  all: ['mealplan'] as const,
  forWeek: (groupId: string, weekStart: string) =>
    [...mealPlanQueryKeys.all, groupId, weekStart] as const,
}

/**
 * Reads the plan for a given group + weekStart. A 404 is a *valid*
 * state (means "no plan yet"), not an error — we surface it via
 * `notFound: true` so the page can show the create-CTA without the
 * consumer having to sniff error codes.
 *
 * `staleTime: 30_000` keeps snappy navigation between weeks; P3-8 will
 * add SignalR-driven invalidation so we don't need aggressive polling.
 */
export function useMealPlan(groupId: string | undefined, weekStart: string | undefined) {
  const query = useQuery<MealPlanDto | null, Error>({
    queryKey:
      groupId && weekStart
        ? mealPlanQueryKeys.forWeek(groupId, weekStart)
        : ['mealplan', 'disabled'],
    queryFn: async () => {
      try {
        return await fetchMealPlan(groupId!, weekStart!)
      } catch (caught) {
        // 404 "no plan yet" is expected — bubble up as null so the
        // component tree can render the create-CTA without branching
        // on the raw HTTP status.
        if (
          caught instanceof MealPlanApiError &&
          (caught.status === 404 || caught.code === 'mealplan.not_found')
        ) {
          return null
        }
        throw caught
      }
    },
    enabled: !!groupId && !!weekStart,
    staleTime: 30_000,
    retry: (failureCount, caught) => {
      if (
        caught instanceof MealPlanApiError &&
        caught.status >= 400 &&
        caught.status < 500
      ) {
        return false
      }
      return failureCount < 2
    },
  })
  return {
    ...query,
    plan: query.data ?? null,
    notFound: query.isSuccess && query.data === null,
  }
}

export function useCreateMealPlan(groupId: string) {
  const client = useQueryClient()
  return useMutation<MealPlanDto, Error, CreateMealPlanRequest>({
    mutationFn: (body) => createMealPlan(groupId, body),
    onSuccess: (created) => {
      client.setQueryData(
        mealPlanQueryKeys.forWeek(groupId, created.weekStart),
        created,
      )
      void client.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(groupId, created.weekStart),
      })
    },
  })
}

export function useAddSlot(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  return useMutation<MealPlanSlotDto, Error, AddSlotRequest>({
    mutationFn: (body) => addSlot(planId, body),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(groupId, weekStart),
      })
    },
  })
}

/**
 * PATCH a slot with JSON Merge Patch semantics. Only fields actually
 * included in `patch` are shipped (see `mealPlanApi.patchSlot` which
 * filters `undefined` keys).
 *
 * Optimistic update: we splice the patch into the cached plan in
 * `onMutate` *before* the network call so the UI reacts immediately
 * (gekocht-toggle ticks, servings update, drag-reordered rows stay
 * where the user dropped them). `onError` rolls the cache back to the
 * pre-mutation snapshot; `onSettled` invalidates so the server stays
 * authoritative and other tabs (P3-8 SignalR will fan out the same
 * invalidation) see the real row.
 */
export function usePatchSlot(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  const queryKey = mealPlanQueryKeys.forWeek(groupId, weekStart)
  return useMutation<
    MealPlanSlotDto,
    Error,
    {
      slotId: string
      patch: PatchSlotRequest
      /**
       * OFF4 — when present, overrides the cached plan-version for
       * this call's `If-Match`. The conflict resolver uses this to
       * retry against the server's current version after a 409.
       */
      expectedVersion?: number
    },
    { previous: MealPlanDto | null | undefined }
  >({
    // `gcTime: 0` evicts the mutation state the moment nothing observes
    // it — keeps an unmounted-mid-flight mutation from persisting a
    // half-applied optimistic snapshot into an unrelated week's cache.
    gcTime: 0,
    mutationFn: ({ slotId, patch, expectedVersion }) => {
      // OFF4 — backend enforces optimistic concurrency on the plan's
      // version (a slot PATCH bumps the plan's Version). Read the
      // current cached plan version or honour an override (keep-local
      // retry path).
      const cached = client.getQueryData<MealPlanDto | null>(queryKey)
      const version = expectedVersion ?? cached?.version
      const ifMatch =
        planId && typeof version === 'number' ? buildIfMatch(planId, version) : undefined
      return patchSlot(planId, slotId, patch, { ifMatch })
    },
    onMutate: async (variables) => {
      // Cancel any in-flight refetch so it can't clobber the optimistic
      // snapshot after we apply it.
      await client.cancelQueries({ queryKey })
      const previous = client.getQueryData<MealPlanDto | null>(queryKey)
      client.setQueryData<MealPlanDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          slots: prev.slots.map((s) =>
            s.id === variables.slotId ? { ...s, ...variables.patch } : s,
          ),
        }
      })
      return { previous }
    },
    onError: (_err, _variables, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(queryKey, context.previous)
      }
    },
    onSuccess: (updated) => {
      // Replace the optimistic row with the server's authoritative DTO —
      // picks up server-computed fields like `updatedAt`.
      client.setQueryData<MealPlanDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          slots: prev.slots.map((s) => (s.id === updated.id ? updated : s)),
        }
      })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey })
    },
  })
}

/**
 * DELETE a slot. The backend detaches child slots (sets their
 * `ParentSlotId` to null) rather than cascade-deleting them, so we
 * still need a full refetch after success to pick up those changes.
 *
 * Optimistic: the row disappears from the grid before the network
 * call; rollback on error restores it.
 */
/**
 * P3-9 "Plan der letzten Woche kopieren" mutation.
 *
 * Calls `POST /api/mealplans/{planId}/copy-from/{sourceWeekStart}` and
 * primes the TanStack cache with the server's freshly-copied plan so
 * the grid flips to the new slots without a round-trip. We also
 * invalidate the week-scoped query key so any in-flight refetch stays
 * authoritative (and SignalR fan-out from P3-8 keeps other tabs in
 * sync).
 *
 * Deliberate scope: no optimistic update — the copy touches many rows
 * including a server-side ParentSlotId remap, so mirroring that in the
 * client would duplicate the backend logic with no real UX win (the
 * call is fast enough that the mutation-pending state carries us).
 */
export function useCopyFromWeek(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  const queryKey = mealPlanQueryKeys.forWeek(groupId, weekStart)
  return useMutation<MealPlanDto, Error, { sourceWeekStart: string }>({
    mutationFn: ({ sourceWeekStart }) => copyFromWeek(planId, sourceWeekStart),
    onSuccess: (copied) => {
      client.setQueryData(queryKey, copied)
      void client.invalidateQueries({ queryKey })
    },
  })
}

export function useDeleteSlot(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  const queryKey = mealPlanQueryKeys.forWeek(groupId, weekStart)
  return useMutation<
    void,
    Error,
    { slotId: string },
    { previous: MealPlanDto | null | undefined }
  >({
    // See `usePatchSlot` — evict on unobserved so a mid-flight delete
    // can't leak an optimistic row-removal into a different week's
    // cache after unmount.
    gcTime: 0,
    mutationFn: ({ slotId }) => deleteSlot(planId, slotId),
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey })
      const previous = client.getQueryData<MealPlanDto | null>(queryKey)
      client.setQueryData<MealPlanDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          slots: prev.slots.filter((s) => s.id !== variables.slotId),
        }
      })
      return { previous }
    },
    onError: (_err, _variables, context) => {
      if (context?.previous !== undefined) {
        client.setQueryData(queryKey, context.previous)
      }
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey })
    },
  })
}
