namespace SharedCookbook.Api.Services;

/// <summary>
/// FLAKY-1 — test seam for fire-and-forget background tasks spawned
/// from request handlers (currently only the chat auto-title path in
/// <c>ChatEndpoints.TurnAsync</c>).
///
/// Production registers <see cref="NullBackgroundTaskTracker"/> which
/// schedules on the thread pool via <c>Task.Run</c> and forgets the
/// handle — identical to the previous inline call.
///
/// Integration tests register a tracking implementation that records
/// every submitted task so the test can await completion
/// deterministically before asserting on side-effects, eliminating
/// the SQLite in-memory contention between the background DbContext
/// write and the foreground read (observed as <c>SqliteException:
/// database is locked</c> / <c>ObjectDisposedException</c> under
/// test parallelism).
/// </summary>
public interface IBackgroundTaskTracker
{
    /// <summary>
    /// Fire the delegate on the thread pool and return immediately.
    /// </summary>
    void Run(Func<Task> factory);
}

/// <summary>
/// Production default — fire-and-forget with no bookkeeping.
/// </summary>
public sealed class NullBackgroundTaskTracker : IBackgroundTaskTracker
{
    public void Run(Func<Task> factory) => _ = Task.Run(factory);
}
