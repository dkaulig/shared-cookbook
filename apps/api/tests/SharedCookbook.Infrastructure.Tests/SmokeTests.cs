using SharedCookbook.Infrastructure;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests;

/// <summary>
/// Smoke test — verifies that the Infrastructure assembly is wired up and its
/// public marker type is reachable. The test fails if the project reference is
/// missing, the assembly name drifts, or the marker constant is altered.
/// Real Infrastructure tests (EF, migrations) arrive with S1.
/// </summary>
public class SmokeTests
{
    [Fact]
    public void InfrastructureMarker_Name_Matches_Assembly_Name()
    {
        var assemblyName = typeof(InfrastructureMarker).Assembly.GetName().Name;

        Assert.Equal("SharedCookbook.Infrastructure", InfrastructureMarker.Name);
        Assert.Equal("SharedCookbook.Infrastructure", assemblyName);
    }
}
