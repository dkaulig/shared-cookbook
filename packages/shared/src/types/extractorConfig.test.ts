import { describe, expect, it } from 'vitest'
import type {
  ExtractorConfigDetailResponse,
  ExtractorConfigHistoryEntry,
  ExtractorConfigItem,
  ExtractorConfigListResponse,
  ExtractorConfigValueType,
  PutExtractorConfigRequest,
} from './extractorConfig.ts'

/**
 * Type-level contract tests for CFG-2's shared DTOs. The .NET side
 * lives in `AdminExtractorConfigEndpoints.cs` — a rename/reshape on
 * either side should fail this file's compile.
 */

describe('extractorConfig.ts DTOs', () => {
  it('ExtractorConfigValueType covers the five JSON shapes the backend emits', () => {
    const types: ExtractorConfigValueType[] = [
      'string',
      'int',
      'float',
      'bool',
      'string_list',
    ]
    expect(types).toHaveLength(5)
  })

  it('ExtractorConfigItem carries key + native JSON value + editor chip fields', () => {
    const item: ExtractorConfigItem = {
      key: 'llm.structured.temperature',
      value: 0.5,
      type: 'float',
      updatedAt: '2026-04-21T20:00:00Z',
      updatedBy: { id: 'u1', displayName: 'Admin' },
      version: 3,
    }
    expect(item.key).toBe('llm.structured.temperature')
    expect(item.version).toBe(3)
  })

  it('ExtractorConfigItem accepts a null editor (migration-seed rows)', () => {
    const seed: ExtractorConfigItem = {
      key: 'feature.chat_enabled',
      value: true,
      type: 'bool',
      updatedAt: '2026-04-21T00:00:00Z',
      updatedBy: null,
      version: 0,
    }
    expect(seed.updatedBy).toBeNull()
  })

  it('ExtractorConfigListResponse wraps the items array', () => {
    const list: ExtractorConfigListResponse = {
      items: [
        {
          key: 'feature.video_import_enabled',
          value: true,
          type: 'bool',
          updatedAt: '2026-04-21T00:00:00Z',
          updatedBy: null,
          version: 0,
        },
      ],
    }
    expect(list.items).toHaveLength(1)
  })

  it('ExtractorConfigHistoryEntry carries old + new JSON values', () => {
    const entry: ExtractorConfigHistoryEntry = {
      oldValue: 0,
      newValue: 0.5,
      changedAt: '2026-04-21T20:00:00Z',
      changedBy: { id: 'u1', displayName: 'Admin' },
    }
    expect(entry.oldValue).toBe(0)
    expect(entry.newValue).toBe(0.5)
  })

  it('ExtractorConfigDetailResponse bundles the current item + last-10 history', () => {
    const detail: ExtractorConfigDetailResponse = {
      item: {
        key: 'llm.structured.temperature',
        value: 0.5,
        type: 'float',
        updatedAt: '2026-04-21T20:00:00Z',
        updatedBy: { id: 'u1', displayName: 'Admin' },
        version: 3,
      },
      history: [],
    }
    expect(detail.item.version).toBe(3)
    expect(detail.history).toHaveLength(0)
  })

  it('PutExtractorConfigRequest carries the new value + optimistic expectedVersion', () => {
    const body: PutExtractorConfigRequest = {
      value: 0.5,
      expectedVersion: 3,
    }
    expect(body.expectedVersion).toBe(3)
  })
})
