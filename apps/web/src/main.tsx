import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
// Bundle Inter locally so the Sage Modern theme works offline and
// does not call Google Fonts (Inter-only typography per DS8).
import './styles/fonts'
import './index.css'
// REL-3 — side-effect import initialises the default i18n singleton
// before the React tree mounts so the first render already has
// translations available. Runs before `import App` so module-level
// code in nav / layout components can read translations eagerly.
import './i18n/bootstrap'
import App from './App.tsx'
import { PwaUpdatePrompt } from './pwa/PwaUpdatePrompt'
import {
  CACHE_VERSION,
  MAX_AGE_MS,
  persister,
  shouldDehydrateQuery,
} from './lib/queryPersister'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    {/*
      OFF1 — hydrate the query cache from IndexedDB on boot so offline
      reloads show last-known recipes/meal-plan/shopping-list
      instantly. The `buster` ties the cache to the app build; a new
      deploy drops stale cache shapes automatically. Ephemeral queries
      (chat, imports, staged photos) are filtered via
      `shouldDehydrateQuery` so reloads don't resume dead sessions.
    */}
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        buster: CACHE_VERSION,
        maxAge: MAX_AGE_MS,
        dehydrateOptions: {
          shouldDehydrateQuery,
        },
      }}
    >
      <App />
      <PwaUpdatePrompt />
    </PersistQueryClientProvider>
  </StrictMode>,
)
