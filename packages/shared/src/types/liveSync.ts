/**
 * SignalR live-sync event payloads (P3-8). The backend LiveSyncHub
 * broadcasts these events to every connection in the owning group so
 * peers see meal-plan and shopping-list changes without manual refetch.
 *
 * Note: the backend ships (groupId, weekStart) inside
 * MealPlanSlotChanged + MealPlanChanged so the frontend can invalidate
 * TanStack-Query caches keyed by ['mealplan', groupId, weekStart]
 * without maintaining a planId→(groupId, weekStart) lookup.
 */

export type LiveSyncAction = 'created' | 'updated' | 'deleted'

export interface MealPlanSlotChangedPayload {
  planId: string
  slotId: string
  groupId: string
  /** ISO YYYY-MM-DD — always a Monday. */
  weekStart: string
  action: LiveSyncAction
}

export interface MealPlanChangedPayload {
  planId: string
  groupId: string
  /** ISO YYYY-MM-DD — always a Monday. */
  weekStart: string
  action: LiveSyncAction
}

export interface ShoppingListItemChangedPayload {
  listId: string
  itemId: string
  planId: string
  action: LiveSyncAction
}

/**
 * Server → client event names. Keep in sync with
 * `LiveSyncEvents` on the backend.
 */
export const LiveSyncEventNames = {
  MealPlanSlotChanged: 'MealPlanSlotChanged',
  MealPlanChanged: 'MealPlanChanged',
  ShoppingListItemChanged: 'ShoppingListItemChanged',
} as const

export type LiveSyncEventName =
  (typeof LiveSyncEventNames)[keyof typeof LiveSyncEventNames]
