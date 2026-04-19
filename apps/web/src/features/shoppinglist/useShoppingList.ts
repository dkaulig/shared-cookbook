import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AddShoppingListItemRequest,
  PatchShoppingListItemRequest,
  ShoppingListDto,
  ShoppingListItemDto,
} from '@familien-kochbuch/shared'
import {
  ShoppingListApiError,
  addShoppingListItem,
  deleteShoppingListItem,
  fetchShoppingList,
  generateShoppingList,
  patchShoppingListItem,
} from './shoppingListApi'

/**
 * TanStack-Query keys for the shopping-list cache. Scoped per meal-plan
 * (one list per plan) — the page wires it up via the planId it already
 * gets from the mealplan cache.
 */
export const shoppingListQueryKeys = {
  all: ['shoppinglist'] as const,
  forPlan: (planId: string) =>
    [...shoppingListQueryKeys.all, planId] as const,
}

/**
 * Reads the shopping list for a given plan. 404 is a valid state (means
 * "list not yet generated") — we surface it via `notFound: true` so the
 * page can render the "Liste erzeugen" CTA without sniffing HTTP codes.
 */
export function useShoppingList(planId: string | undefined) {
  const query = useQuery<ShoppingListDto | null, Error>({
    queryKey: planId
      ? shoppingListQueryKeys.forPlan(planId)
      : ['shoppinglist', 'disabled'],
    queryFn: async () => {
      try {
        return await fetchShoppingList(planId!)
      } catch (caught) {
        if (
          caught instanceof ShoppingListApiError &&
          (caught.status === 404 || caught.code === 'shopping_list.not_found')
        ) {
          return null
        }
        throw caught
      }
    },
    enabled: !!planId,
    staleTime: 30_000,
    retry: (failureCount, caught) => {
      if (
        caught instanceof ShoppingListApiError &&
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
    list: query.data ?? null,
    notFound: query.isSuccess && query.data === null,
  }
}

/**
 * Triggers `POST …/shopping-list/generate`. On success, primes the
 * per-plan cache with the server response so the page doesn't have to
 * re-fetch before rendering.
 */
export function useGenerateShoppingList(planId: string) {
  const client = useQueryClient()
  return useMutation<ShoppingListDto, Error, void>({
    mutationFn: () => generateShoppingList(planId),
    onSuccess: (list) => {
      client.setQueryData(shoppingListQueryKeys.forPlan(planId), list)
      void client.invalidateQueries({
        queryKey: shoppingListQueryKeys.forPlan(planId),
      })
    },
  })
}

type PatchVariables = { itemId: string; patch: PatchShoppingListItemRequest }
type MutationContext = { previous: ShoppingListDto | null | undefined }

/**
 * PATCH an item (check-off toggle or note edit). Same optimistic-update
 * pattern as `usePatchSlot`: splice into the cached list in `onMutate`
 * so the UI flips instantly, roll back in `onError`, reconcile with the
 * server DTO in `onSuccess`, refetch in `onSettled` (so P3-8 SignalR
 * invalidation stays authoritative when it lands).
 */
export function usePatchShoppingListItem(planId: string, listId: string) {
  const client = useQueryClient()
  const queryKey = shoppingListQueryKeys.forPlan(planId)
  return useMutation<
    ShoppingListItemDto,
    Error,
    PatchVariables,
    MutationContext
  >({
    mutationFn: ({ itemId, patch }) =>
      patchShoppingListItem(listId, itemId, patch),
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey })
      const previous = client.getQueryData<ShoppingListDto | null>(queryKey)
      client.setQueryData<ShoppingListDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          items: prev.items.map((i) =>
            i.id === variables.itemId ? { ...i, ...variables.patch } : i,
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
      client.setQueryData<ShoppingListDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          items: prev.items.map((i) => (i.id === updated.id ? updated : i)),
        }
      })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey })
    },
  })
}

/**
 * POST a manual item. No optimistic insert — we don't know the
 * server-assigned `id` / `sortOrder` / timestamps and splicing an
 * incomplete row into the cache would flicker on success.
 */
export function useAddShoppingListItem(planId: string, listId: string) {
  const client = useQueryClient()
  return useMutation<ShoppingListItemDto, Error, AddShoppingListItemRequest>({
    mutationFn: (body) => addShoppingListItem(listId, body),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: shoppingListQueryKeys.forPlan(planId),
      })
    },
  })
}

type DeleteVariables = { itemId: string }

export function useDeleteShoppingListItem(planId: string, listId: string) {
  const client = useQueryClient()
  const queryKey = shoppingListQueryKeys.forPlan(planId)
  return useMutation<void, Error, DeleteVariables, MutationContext>({
    mutationFn: ({ itemId }) => deleteShoppingListItem(listId, itemId),
    onMutate: async (variables) => {
      await client.cancelQueries({ queryKey })
      const previous = client.getQueryData<ShoppingListDto | null>(queryKey)
      client.setQueryData<ShoppingListDto | null>(queryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          items: prev.items.filter((i) => i.id !== variables.itemId),
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
