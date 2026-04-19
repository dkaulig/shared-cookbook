import { describe, expect, it } from 'vitest'
import type {
  AiUsageGroupBy,
  AiUsageGroupedRow,
  AiUsageSummary,
} from './aiUsage.ts'

/**
 * Type-level contract tests for the PF2 admin AI-usage DTOs. Mirrors
 * `AdminAiUsageEndpoints.AiUsageSummaryDto` on the .NET side — a
 * breaking rename / reshape either here or there surfaces in this
 * file's failing compile.
 */

describe('aiUsage.ts DTOs', () => {
  it('AiUsageGroupBy covers the three axes the endpoint supports', () => {
    const axes: AiUsageGroupBy[] = ['user', 'model', 'day']
    expect(axes).toHaveLength(3)
  })

  it('AiUsageGroupedRow carries token counts + USD + EUR per bucket', () => {
    const row: AiUsageGroupedRow = {
      key: 'gpt-5.1-chat',
      promptTokens: 1_500_000,
      completionTokens: 300_000,
      cachedTokens: 200_000,
      usd: 4.38,
      eur: 4.03,
    }
    expect(row.key).toBe('gpt-5.1-chat')
    expect(row.promptTokens + row.completionTokens).toBeGreaterThan(0)
  })

  it('AiUsageSummary exposes grand totals + the grouped rows', () => {
    const summary: AiUsageSummary = {
      totalPromptTokens: 2_000_000,
      totalCompletionTokens: 400_000,
      totalCachedTokens: 300_000,
      totalUsd: 6.50,
      totalEur: 5.98,
      groupBy: 'model',
      groups: [
        {
          key: 'gpt-5.1',
          promptTokens: 1_000_000,
          completionTokens: 200_000,
          cachedTokens: 100_000,
          usd: 3.25,
          eur: 2.99,
        },
        {
          key: 'gpt-4.1-mini',
          promptTokens: 1_000_000,
          completionTokens: 200_000,
          cachedTokens: 200_000,
          usd: 3.25,
          eur: 2.99,
        },
      ],
    }
    expect(summary.groupBy).toBe('model')
    expect(summary.groups).toHaveLength(2)
    expect(summary.totalPromptTokens).toBe(2_000_000)
  })

  it('AiUsageSummary accepts an empty groups array for empty ranges', () => {
    const empty: AiUsageSummary = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalCachedTokens: 0,
      totalUsd: 0,
      totalEur: 0,
      groupBy: 'user',
      groups: [],
    }
    expect(empty.groups).toHaveLength(0)
  })
})
