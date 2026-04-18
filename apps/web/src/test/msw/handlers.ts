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
]
