/**
 * CFG-2 — Extractor-Config DTOs consumed by the admin UI.
 *
 * Mirror the .NET `AdminExtractorConfigEndpoints` shapes
 * (`ConfigItemDto`, `ConfigListResponse`, `HistoryEntryDto`,
 * `ConfigDetailResponse`). Hand-written; kept in shared so the
 * Python + .NET + React layers all speak the same vocabulary if we
 * ever build a typed API client generator.
 *
 * `value` is intentionally typed `unknown` — the backend stores a raw
 * `JsonElement` and hands it back as the native JSON shape the admin
 * UI needs (number / string / bool / string[]). Consumers narrow via
 * the `type` discriminator.
 */
export type ExtractorConfigValueType =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'string_list'

export interface ExtractorConfigUpdatedBy {
  id: string
  displayName: string
}

export interface ExtractorConfigItem {
  key: string
  value: unknown
  type: ExtractorConfigValueType
  updatedAt: string
  updatedBy: ExtractorConfigUpdatedBy | null
  version: number
}

export interface ExtractorConfigListResponse {
  items: ExtractorConfigItem[]
}

export interface ExtractorConfigHistoryEntry {
  oldValue: unknown
  newValue: unknown
  changedAt: string
  changedBy: ExtractorConfigUpdatedBy | null
}

export interface ExtractorConfigDetailResponse {
  item: ExtractorConfigItem
  history: ExtractorConfigHistoryEntry[]
}

export interface PutExtractorConfigRequest {
  value: unknown
  expectedVersion: number
}
