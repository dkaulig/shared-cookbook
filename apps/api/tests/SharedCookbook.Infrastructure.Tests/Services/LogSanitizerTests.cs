using SharedCookbook.Infrastructure.Services;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

public class LogSanitizerTests
{
    [Fact]
    public void ForLog_PreservesNull()
    {
        Assert.Null(LogSanitizer.ForLog(null));
    }

    [Fact]
    public void ForLog_PreservesEmpty()
    {
        Assert.Equal(string.Empty, LogSanitizer.ForLog(string.Empty));
    }

    [Fact]
    public void ForLog_ReturnsSameInstanceWhenCleanFastPath()
    {
        // No \r \n \t → fast path returns the original reference.
        const string input = "/api/recipes/abc-123?q=foo";
        var result = LogSanitizer.ForLog(input);
        Assert.Same(input, result);
    }

    [Theory]
    [InlineData("/api/x\nFAKE-LOG", "/api/x_FAKE-LOG")]
    [InlineData("/api/x\rFAKE-LOG", "/api/x_FAKE-LOG")]
    [InlineData("/api/x\tFAKE-LOG", "/api/x_FAKE-LOG")]
    [InlineData("a\r\nb\tc", "a__b_c")]
    public void ForLog_ReplacesCrLfTab(string input, string expected)
    {
        Assert.Equal(expected, LogSanitizer.ForLog(input));
    }
}
