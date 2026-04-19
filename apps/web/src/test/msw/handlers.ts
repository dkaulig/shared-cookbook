import { http, HttpResponse } from 'msw'
import type { HealthResponse } from '@familien-kochbuch/shared/types'

/**
 * Default MSW handlers used across the test suite. Individual tests can
 * override or add handlers via `server.use(...)`.
 */
export const handlers = [
  http.get('/api/health', () =>
    HttpResponse.json<HealthResponse>({
      status: 'ok',
      timestamp: new Date().toISOString(),
    }),
  ),
  // P3-8 — any component using <AppLayout /> or ProtectedRoute
  // transitively invokes `useLiveSync`, which negotiates against
  // `/api/hubs/live`. Return a 404 so SignalR's start() rejects fast;
  // the hook swallows that into a single console.warn and tests don't
  // tie up on a retry loop.
  http.post('/api/hubs/live/negotiate', () => new HttpResponse(null, { status: 404 })),
  http.all('/api/hubs/live', () => new HttpResponse(null, { status: 404 })),
]
