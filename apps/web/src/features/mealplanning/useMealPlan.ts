import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddSlotRequest,
  CreateMealPlanRequest,
  MealPlanDto,
  MealPlanSlotDto,
  PatchSlotRequest,
} from '@familien-kochbuch/shared'
import {
  MealPlanApiError,
  addSlot,
  createMealPlan,
  deleteSlot,
  fetchMealPlan,
  patchSlot,
} from './mealPlanApi'

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
 * filters `undefined` keys). The server responds with the updated
 * slot DTO; we splice it into the cached plan so the UI reflects
 * servings / recipe / isCooked / sortOrder changes without a refetch,
 * then invalidate to keep other tabs (P3-8 SignalR will trigger the
 * same invalidation path) consistent.
 */
export function usePatchSlot(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  return useMutation<
    MealPlanSlotDto,
    Error,
    { slotId: string; patch: PatchSlotRequest }
  >({
    mutationFn: ({ slotId, patch }) => patchSlot(planId, slotId, patch),
    onSuccess: (updated) => {
      client.setQueryData<MealPlanDto | null>(
        mealPlanQueryKeys.forWeek(groupId, weekStart),
        (prev) => {
          if (!prev) return prev
          return {
            ...prev,
            slots: prev.slots.map((s) => (s.id === updated.id ? updated : s)),
          }
        },
      )
      void client.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(groupId, weekStart),
      })
    },
  })
}

/**
 * DELETE a slot. The backend detaches child slots (sets their
 * `ParentSlotId` to null) rather than cascade-deleting them, so we
 * still need a full refetch after success to pick up those changes.
 */
export function useDeleteSlot(groupId: string, weekStart: string, planId: string) {
  const client = useQueryClient()
  return useMutation<void, Error, { slotId: string }>({
    mutationFn: ({ slotId }) => deleteSlot(planId, slotId),
    onSuccess: (_data, variables) => {
      client.setQueryData<MealPlanDto | null>(
        mealPlanQueryKeys.forWeek(groupId, weekStart),
        (prev) => {
          if (!prev) return prev
          return {
            ...prev,
            slots: prev.slots.filter((s) => s.id !== variables.slotId),
          }
        },
      )
      void client.invalidateQueries({
        queryKey: mealPlanQueryKeys.forWeek(groupId, weekStart),
      })
    },
  })
}
