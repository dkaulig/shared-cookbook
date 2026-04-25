import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  HttpTransportType,
  type IRetryPolicy,
} from '@microsoft/signalr'
import { nextReconnectDelayForContext } from './reconnectBackoff'

/**
 * Minimal shape of the live-sync client the hook uses. A dedicated
 * interface lets tests inject a fake without wiring a real WebSocket,
 * and keeps the hook free of concrete SignalR types on its public
 * surface (the backend payload types live in @shared-cookbook/shared).
 */
export interface LiveSyncClient {
  start(): Promise<void>
  stop(): Promise<void>
  on<T>(eventName: string, handler: (payload: T) => void): void
  off(eventName: string): void
  readonly state: HubConnectionState
}

/**
 * Thin wrapper over a <see cref="HubConnection"/> so the hook never
 * touches concrete SignalR APIs directly. Keeps the hook replaceable
 * in tests via <see cref="createFakeLiveSyncClient"/>-style factories
 * without dragging in the real WebSocket stack.
 */
class SignalRLiveSyncClient implements LiveSyncClient {
  private readonly connection: HubConnection

  constructor(connection: HubConnection) {
    this.connection = connection
  }

  get state(): HubConnectionState {
    return this.connection.state
  }

  start(): Promise<void> {
    return this.connection.start()
  }

  async stop(): Promise<void> {
    // `stop()` rejects if the connection is already closing — swallow
    // that specific edge so a React Strict-Mode double-unmount doesn't
    // log a spurious error.
    try {
      await this.connection.stop()
    } catch {
      // intentional: see above.
    }
  }

  on<T>(eventName: string, handler: (payload: T) => void): void {
    this.connection.on(eventName, handler)
  }

  off(eventName: string): void {
    this.connection.off(eventName)
  }
}

/**
 * SignalR retry policy aligned with the plan's backoff schedule
 * (500ms → 1s → 2s → 5s → 10s → 30s cap). Clean separation from the
 * math in <see cref="reconnectBackoff.ts"/> keeps the schedule unit-
 * testable and the retry policy trivially wrapping it.
 *
 * Surrenders (returns <c>null</c>) when the JWT is rejected for the
 * 4th time in a row (after 3 retries the token is definitively stale)
 * or when total elapsed retry time crosses 10 min — whichever comes
 * first. Both thresholds live in <c>reconnectBackoff.ts</c> so they
 * stay unit-testable without a SignalR transport.
 */
const liveSyncRetryPolicy: IRetryPolicy = {
  nextRetryDelayInMilliseconds(retryContext) {
    return nextReconnectDelayForContext({
      previousRetryCount: retryContext.previousRetryCount,
      elapsedMilliseconds: retryContext.elapsedMilliseconds,
      retryReason: retryContext.retryReason,
    })
  },
}

/**
 * Builds a real SignalR-backed <see cref="LiveSyncClient"/>. The
 * <paramref name="accessTokenFactory"/> is invoked on each
 * (re)connect so a refresh-rotated token is picked up the next time
 * SignalR reconnects.
 */
export function createSignalRLiveSyncClient(
  url: string,
  accessTokenFactory: () => string | null,
): LiveSyncClient {
  // `HubConnectionBuilder.build()` requires an absolute URL or a
  // relative one it can resolve against `window.location` — in
  // jsdom-backed test runs SignalR's internal parser chokes on bare
  // paths, so we resolve up-front against the current origin when one
  // exists. Falls back to the raw string for non-browser hosts (e.g.
  // SSR) so it keeps the same contract.
  const resolvedUrl =
    typeof window !== 'undefined' && window.location?.origin
      ? new URL(url, window.location.origin).toString()
      : url

  const connection = new HubConnectionBuilder()
    .withUrl(resolvedUrl, {
      // WebSockets first; the browser transparently falls back to
      // long-polling when the upgrade fails (e.g. an ancient proxy).
      transport:
        HttpTransportType.WebSockets | HttpTransportType.LongPolling,
      accessTokenFactory: () => accessTokenFactory() ?? '',
    })
    .withAutomaticReconnect(liveSyncRetryPolicy)
    .build()
  return new SignalRLiveSyncClient(connection)
}

export { HubConnectionState }
