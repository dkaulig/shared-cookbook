namespace SharedCookbook.Domain.Common;

/// <summary>
/// Marks a domain aggregate whose mutations bump a monotonically
/// increasing <see cref="Version"/> counter. Phase 5 / OFF3 uses this
/// as the payload for weak ETags (<c>W/"&lt;id&gt;-&lt;version&gt;"</c>)
/// and the <c>If-Match</c> optimistic-concurrency check on mutation
/// endpoints.
///
/// Invariants (enforced by implementers):
/// <list type="bullet">
///   <item><see cref="Version"/> starts at 0 on construction.</item>
///   <item>Only mutation methods may increment — no public setter.</item>
///   <item>Every public mutation method calls <see cref="BumpVersion"/>
///         exactly once per state change.</item>
/// </list>
/// The existing <c>MealPlan</c> pattern (P3-9) pre-dates this
/// interface; its <c>BumpVersion(DateTimeOffset at)</c> overload is
/// kept alongside the parameterless form so slot-mutation endpoints
/// that also refresh <c>UpdatedAt</c> stay terse.
/// </summary>
public interface IVersionedEntity
{
    int Version { get; }

    void BumpVersion();
}
