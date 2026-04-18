using Xunit;

namespace FamilienKochbuch.Infrastructure.Tests;

/// <summary>
/// Smoke test — verifies that the test harness and project references compile.
/// Real Infrastructure tests (EF, migrations) arrive with S1.
/// </summary>
public class SmokeTests
{
    [Fact]
    public void Infrastructure_Test_Project_Compiles_And_Runs()
    {
        Assert.True(true);
    }
}
