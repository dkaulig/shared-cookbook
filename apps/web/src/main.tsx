import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
// Bundle Inter locally so the Sage Modern theme works offline and
// does not call Google Fonts (Inter-only typography per DS8).
import './styles/fonts'
import './index.css'
import App from './App.tsx'
import { PwaUpdatePrompt } from './pwa/PwaUpdatePrompt'

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
    <QueryClientProvider client={queryClient}>
      <App />
      <PwaUpdatePrompt />
    </QueryClientProvider>
  </StrictMode>,
)
