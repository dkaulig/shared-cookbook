import type { HealthResponse } from '@familien-kochbuch/shared/types'

/**
 * Fetches the API health status. Uses the `/api` path which is proxied to
 * the .NET backend in both Vite dev server and Caddy prod reverse proxy.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch('/api/health', { signal })

  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as HealthResponse
}
