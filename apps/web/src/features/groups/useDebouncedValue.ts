import { useEffect, useState } from 'react'

/**
 * Returns a debounced reflection of <paramref name="value"/>. The output
 * updates <paramref name="delayMs"/> milliseconds after the most recent
 * change; rapid keystrokes collapse into a single trailing update.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(handle)
  }, [value, delayMs])

  return debounced
}
