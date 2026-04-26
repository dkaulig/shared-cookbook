using SharedCookbook.Infrastructure.Services;
using Xunit;

namespace SharedCookbook.Infrastructure.Tests.Services;

public class EmailMaskingTests
{
    [Theory]
    [InlineData("a@b.de", "a***@b.de")]                                  // 1-char local
    [InlineData("ab@b.de", "a***@b.de")]                                 // 2-char local → 1 visible
    [InlineData("abc@b.de", "a***@b.de")]                                // 3-char local → 1 visible
    [InlineData("abcd@b.de", "ab***@b.de")]                              // 4-char local → 2 visible
    [InlineData("orchestrator@example.com", "or***@example.com")]        // typical user
    [InlineData("admin@kochbuch.kaulig.dev", "ad***@kochbuch.kaulig.dev")] // multi-dot domain
    public void Mask_ProducesExpectedShape(string input, string expected)
    {
        Assert.Equal(expected, EmailMasking.Mask(input));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public void Mask_PreservesEmptyAndNull(string? input)
    {
        Assert.Equal(input ?? string.Empty, EmailMasking.Mask(input));
    }

    [Theory]
    [InlineData("not-an-email")]   // no @
    [InlineData("@example.com")]   // empty local
    public void Mask_ReturnsUnchangedForNonEmail(string input)
    {
        // Non-emails fall through — caller's input was wrong, helper is
        // not in the business of validating addresses.
        Assert.Equal(input, EmailMasking.Mask(input));
    }
}
