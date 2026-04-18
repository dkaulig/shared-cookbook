using Xunit;

namespace FamilienKochbuch.Domain.Tests;

/// <summary>
/// Smoke test — verifies that the test harness and project references compile.
/// Real Domain-layer tests arrive with S1 (entities, value objects).
/// </summary>
public class SmokeTests
{
    [Fact]
    public void Domain_Test_Project_Compiles_And_Runs()
    {
        Assert.True(true);
    }
}
