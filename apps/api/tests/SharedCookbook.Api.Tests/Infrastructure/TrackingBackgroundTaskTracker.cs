using SharedCookbook.Api.Services;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// FLAKY-1 — test-only <see cref="IBackgroundTaskTracker"/> that
/// records every fire-and-forget task submitted by a request handler
/// so the integration tests can <c>await tracker.WhenAllAsync()</c>
/// before asserting on side-effects.
///
/// Solves the SQLite-in-memory contention where the production
/// <c>Task.Run(...)</c> for chat auto-title races the foreground read
/// in the test on the shared SQLite connection. The race manifests as
/// <c>SqliteException: database is locked</c> or
/// <c>ObjectDisposedException</c> on CI, or an intermittent pass/fail
/// locally.
///
/// Thread-safe: <see cref="Run"/> + <see cref="WhenAllAsync"/> can be
/// called concurrently across parallel test classes sharing the same
/// web-application factory (only the current ChatEndpointsTests
/// fixture uses it today, but the implementation stays defensive).
/// </summary>
public sealed class TrackingBackgroundTaskTracker : IBackgroundTaskTracker
{
    private readonly Lock _gate = new();
    private readonly List<Task> _tasks = new();

    public void Run(Func<Task> factory)
    {
        // Task.Run matches the production scheduling semantics
        // (thread-pool, not inline on the caller).
        var task = Task.Run(factory);
        lock (_gate) _tasks.Add(task);
    }

    /// <summary>
    /// Await every task submitted so far. Safe to call repeatedly;
    /// completed tasks are drained from the list on each call so the
    /// next await only waits for newly-scheduled work.
    /// Swallows exceptions — the production handlers wrap their own
    /// try/catch and a background failure must not fail the test with
    /// an unobserved-exception flag.
    /// </summary>
    public async Task WhenAllAsync()
    {
        Task[] snapshot;
        lock (_gate)
        {
            snapshot = _tasks.ToArray();
            _tasks.Clear();
        }
        if (snapshot.Length == 0) return;
        try
        {
            await Task.WhenAll(snapshot).ConfigureAwait(false);
        }
        catch
        {
            // Production handlers already log inside their try/catch.
            // Swallow here so a background logging failure doesn't
            // mask the foreground assertion the test is actually
            // making.
        }
    }

}
