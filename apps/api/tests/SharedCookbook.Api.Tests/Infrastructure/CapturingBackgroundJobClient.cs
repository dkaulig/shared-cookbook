using Hangfire;
using Hangfire.Common;
using Hangfire.States;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// Test double for Hangfire's <see cref="IBackgroundJobClient"/> that
/// records every <see cref="Create"/> call so P2-6 enqueue-endpoint
/// tests can assert the job type + arguments. The real Hangfire server
/// never runs — the captured <see cref="Job"/> is inspected directly.
///
/// Not thread-safe in the sense of strict ordering under concurrent
/// writes, but the test harness dispatches one request at a time so
/// the <see cref="List{T}"/> is fine.
/// </summary>
public sealed class CapturingBackgroundJobClient : IBackgroundJobClient
{
    private readonly List<CapturedJob> _created = new();
    private readonly object _gate = new();

    public IReadOnlyList<CapturedJob> Created
    {
        get
        {
            lock (_gate) return _created.ToArray();
        }
    }

    public void Reset()
    {
        lock (_gate) _created.Clear();
    }

    public readonly record struct CapturedJob(Job Job, IState State);

    public string Create(Job job, IState state)
    {
        var id = Guid.NewGuid().ToString("N");
        lock (_gate) _created.Add(new CapturedJob(job, state));
        return id;
    }

    public bool ChangeState(string jobId, IState state, string expectedState)
    {
        // P2-6 enqueue endpoints never transition states — they only
        // fire-and-forget. This stays a no-op; tests that need state
        // changes should use Hangfire.InMemory + a real client.
        return true;
    }
}
