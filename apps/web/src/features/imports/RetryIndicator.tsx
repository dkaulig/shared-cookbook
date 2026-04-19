import { RefreshCw } from 'lucide-react'

interface RetryIndicatorProps {
  /** Current attempt number (1-indexed). */
  attemptNumber: number
  /** Total allowed attempts; defaults to 3 to match the backend's retry cap. */
  maxAttempts?: number
}

/**
 * Amber pill shown only when the extraction is on retry attempt ≥ 2.
 * Silent on the first attempt so the UI is not cluttered in the common
 * happy path. Copy matches the design doc §Target UX:
 * *"Erneuter Versuch 2/3"*.
 */
export function RetryIndicator({
  attemptNumber,
  maxAttempts = 3,
}: RetryIndicatorProps) {
  if (attemptNumber <= 1) return null
  const label = `Erneuter Versuch ${attemptNumber}/${maxAttempts}`
  return (
    <div
      data-testid="retry-indicator"
      className="inline-flex items-center gap-2 rounded-full border border-amber-300/60 bg-amber-50 px-3 py-1 text-[12.5px] font-medium text-amber-900"
    >
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </div>
  )
}
