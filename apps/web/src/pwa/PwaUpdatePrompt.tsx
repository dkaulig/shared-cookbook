import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { registerPwa, type UpdateSW } from './registerSW'

/**
 * Small floating toast that appears when the PWA service worker has
 * downloaded a new version. Clicking "Neu laden" calls updateSW(true)
 * which takes over and reloads the page so the new bundle is served.
 *
 * Mount this once near the app root. Safe to render in development —
 * the plugin is dormant unless the build produced a service worker.
 */
export function PwaUpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false)
  // useRef instead of useState: `updateFn` is a side-effect handle, not
  // UI state. This also sidesteps the `react-hooks/set-state-in-effect`
  // lint rule — we write the ref during the effect without triggering
  // a re-render.
  const updateFnRef = useRef<UpdateSW | null>(null)

  useEffect(() => {
    updateFnRef.current = registerPwa({
      onNeedRefresh: () => setShowUpdate(true),
    })
  }, [])

  if (!showUpdate) return null

  async function handleReload() {
    const fn = updateFnRef.current
    if (!fn) return
    await fn(true)
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-lg bg-stone-900 px-4 py-3 text-sm text-white shadow-lg ring-1 ring-black/20"
    >
      <span>Neue Version verfügbar. Seite neu laden?</span>
      <Button type="button" size="sm" variant="outline" onClick={handleReload}>
        Neu laden
      </Button>
    </div>
  )
}
