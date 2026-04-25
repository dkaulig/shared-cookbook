using SharedCookbook.Domain;
using Xunit;

namespace SharedCookbook.Domain.Tests;

/// <summary>
/// Smoke test — verifies that the Domain assembly is wired up and its public
/// marker type is reachable. The test fails if the project reference is
/// missing, the assembly name drifts, or the marker constant is altered.
/// Real Domain-layer tests (entities, value objects) arrive with S1.
/// </summary>
public class SmokeTests
{
    [Fact]
    public void DomainMarker_Name_Matches_Assembly_Name()
    {
        var assemblyName = typeof(DomainMarker).Assembly.GetName().Name;

        Assert.Equal("SharedCookbook.Domain", DomainMarker.Name);
        Assert.Equal("SharedCookbook.Domain", assemblyName);
    }
}
