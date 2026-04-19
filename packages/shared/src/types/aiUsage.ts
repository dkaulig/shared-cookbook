/**
 * PF2 admin AI-usage dashboard DTOs — mirror the .NET
 * `AdminAiUsageEndpoints.AiUsageSummaryDto` and
 * `AiUsageGroupedRowDto` shapes.
 *
 * The endpoint aggregates token spend across two server-side tables:
 * - `RecipeImport` rows where the job recorded token usage.
 * - `ChatUsageLog` rows.
 *
 * All token totals are integers. USD + EUR are decimals but arrive as
 * JSON numbers; the client stores them as `number` since JS's 53-bit
 * safe-integer range is comfortable for the realistic annual-cost
 * scale (cents of EUR over a family-sized deployment).
 */

/**
 * Grouping axis. Picked by the UI via the period / breakdown picker;
 * forwarded as `?groupBy=user|model|day` to the .NET endpoint.
 */
export type AiUsageGroupBy = 'user' | 'model' | 'day'

/**
 * One bar in the grouped breakdown. `key` is the display label for
 * the axis (user display name, deployment name, or ISO date string).
 */
export interface AiUsageGroupedRow {
  key: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  usd: number
  eur: number
}

/**
 * Top-level admin-usage response.
 *
 * `groupBy` echoes the server's chosen axis so the UI can render the
 * right column header even when no explicit param was sent (server
 * default is `"model"`).
 */
export interface AiUsageSummary {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalCachedTokens: number
  totalUsd: number
  totalEur: number
  groupBy: AiUsageGroupBy
  groups: AiUsageGroupedRow[]
}
