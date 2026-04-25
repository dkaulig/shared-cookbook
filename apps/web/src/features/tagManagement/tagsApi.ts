import type { ApiError, TagCategory, TagDto } from '@shared-cookbook/shared'
import { apiClient } from '@/features/auth/apiClient'

async function request<T>(input: RequestInfo | URL, init?: RequestInit, emptyResult?: T): Promise<T> {
  const response = await apiClient(input, init)
  if (!response.ok) {
    await throwApiError(response)
  }
  if (response.status === 204 || response.headers.get('Content-Length') === '0') {
    return (emptyResult as T) ?? (undefined as unknown as T)
  }
  return (await response.json()) as T
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiError | null = null
  try {
    payload = (await response.json()) as ApiError
  } catch {
    /* non-JSON body — fall through */
  }
  const code = payload?.code ?? `http_${response.status}`
  const message = payload?.message ?? response.statusText
  const err = new Error(`${code}: ${message}`) as Error & ApiError
  err.code = code
  err.message = message
  // REL-4: pin status + fieldName from the body so downstream
  // classifiers route by authoritative number.
  err.status = payload?.status ?? response.status
  if (payload?.fieldName) err.fieldName = payload.fieldName
  throw err
}

export interface CreateTagRequest {
  name: string
  category: TagCategory
}

export async function createGroupTag(groupId: string, body: CreateTagRequest): Promise<TagDto> {
  return request<TagDto>(`/api/groups/${encodeURIComponent(groupId)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function deleteGroupTag(groupId: string, tagId: string): Promise<void> {
  await request<void>(
    `/api/groups/${encodeURIComponent(groupId)}/tags/${encodeURIComponent(tagId)}`,
    { method: 'DELETE' },
  )
}
