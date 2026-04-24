import { useQuery } from '@tanstack/react-query'

/**
 * REL-7 — frontend mirror of the API's <c>AiFeatureFlagsDto</c>.
 *
 * Fed by `GET /api/meta/features` (anonymous, Cache-Control: 60s) and
 * consumed by the `<FeatureGate>` component + direct `useFeatures()`
 * callers that need to conditionally render import CTAs, chat links,
 * or swap the URL-import page into raw-text pre-fill mode.
 *
 * Shape mirrors the .NET record names but camelCase by the default
 * System.Text.Json serialiser (ASP.NET camel-cases property names on
 * the wire).
 */
export type AiFeatureFlags = {
  urlImport: boolean
  jsonldImport: boolean
  videoImport: boolean
  photoImport: boolean
  chat: boolean
}

export type AiFeatures = {
  enabled: boolean
  provider: 'azure' | 'ollama' | null
  features: AiFeatureFlags
}

export type Features = {
  ai: AiFeatures
}

/**
 * Optimistic "AI on" placeholder used while the features endpoint is
 * still in-flight. Rationale: the UX penalty for a brief AI-on flash
 * that collapses once the query resolves is smaller than the penalty
 * for an AI-off → AI-on flash that slides the CTAs in as the query
 * resolves (the latter causes layout jump). Tests rely on this too —
 * they render the component and expect its full JSX without having to
 * `waitFor` a trivial anonymous query to settle.
 */
const AI_ON_OPTIMISTIC: Features = {
  ai: {
    enabled: true,
    provider: null,
    features: {
      urlImport: true,
      jsonldImport: true,
      videoImport: true,
      photoImport: true,
      chat: true,
    },
  },
}

/**
 * Static "AI off" fallback used when the endpoint has definitively
 * failed (error state, no retries left). Hides AI CTAs so a broken
 * backend doesn't surface click-through → 503.
 */
const AI_OFF_FALLBACK: Features = {
  ai: {
    enabled: false,
    provider: null,
    features: {
      urlImport: false,
      jsonldImport: true,
      videoImport: false,
      photoImport: false,
      chat: false,
    },
  },
}

async function fetchFeatures(signal?: AbortSignal): Promise<Features> {
  const response = await fetch('/api/meta/features', { signal })
  if (!response.ok) {
    throw new Error(`features probe failed: ${response.status}`)
  }
  const body = (await response.json()) as Features
  return body
}

/**
 * Fetch-once-per-session hook reading feature-flags from the API.
 *
 * Long stale time (10 min) + the `Cache-Control: public, max-age=60`
 * on the response keeps this essentially free on navigation. States:
 *
 *   - loading (first mount, no data yet) → returns
 *     `AI_ON_OPTIMISTIC`. Most instances HAVE AI so the optimistic
 *     render collapses gracefully to AI-on once the fetch settles.
 *   - success → returns the server's snapshot verbatim.
 *   - error (exhausted retries) → returns `AI_OFF_FALLBACK` so a dead
 *     endpoint doesn't leak AI CTAs that 503 on click.
 */
export function useFeatures(): Features {
  const query = useQuery<Features>({
    queryKey: ['meta', 'features'],
    queryFn: ({ signal }) => fetchFeatures(signal),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  })
  if (query.data) return query.data
  if (query.isError) return AI_OFF_FALLBACK
  return AI_ON_OPTIMISTIC
}
