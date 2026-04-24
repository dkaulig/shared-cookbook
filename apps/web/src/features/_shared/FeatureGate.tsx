import type { ReactNode } from 'react'
import { useFeatures, type AiFeatureFlags } from './useFeatures'

/**
 * REL-7 — conditionally render children based on an AI feature flag.
 *
 * Usage:
 *   <FeatureGate feature="chat">
 *     <Link to="/chat">Chat-Import</Link>
 *   </FeatureGate>
 *
 * Hides the subtree when `features.ai.features[feature]` is `false`
 * (e.g. when the operator disabled AI or picked a provider that can't
 * serve that capability). Callers that need an alternative render
 * pass `fallback`; omitted → null.
 *
 * Used alongside the direct `useFeatures()` hook for more complex
 * gating (e.g. ImportUrlPage flipping into raw-text mode instead of
 * hiding itself).
 */
export function FeatureGate({
  feature,
  children,
  fallback = null,
}: {
  feature: keyof AiFeatureFlags
  children: ReactNode
  fallback?: ReactNode
}) {
  const { ai } = useFeatures()
  if (!ai.features[feature]) return <>{fallback}</>
  return <>{children}</>
}
