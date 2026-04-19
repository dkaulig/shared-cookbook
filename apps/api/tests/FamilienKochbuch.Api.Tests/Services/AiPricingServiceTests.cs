using FamilienKochbuch.Api.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// Unit tests for PF2 <see cref="AiPricingService"/>. Pins every
/// deployment's per-1M rate, the cached-input split, EUR conversion,
/// and the unknown-model fallback.
/// </summary>
public class AiPricingServiceTests
{
    private static AiPricingOptions BuildOptions(decimal usdToEurRate = 0.92m)
    {
        return new AiPricingOptions
        {
            UsdToEurRate = usdToEurRate,
            Models = new Dictionary<string, ModelRates>
            {
                ["gpt-4.1"] = new() { Input = 2.00m, Output = 8.00m, Cached = 0.50m },
                ["gpt-4.1-mini"] = new() { Input = 0.40m, Output = 1.60m, Cached = 0.10m },
                ["gpt-5.1"] = new() { Input = 1.25m, Output = 10.00m, Cached = 0.13m },
                ["gpt-5.1-chat"] = new() { Input = 1.25m, Output = 10.00m, Cached = 0.13m },
                ["gpt-5.1-codex-mini"] = new() { Input = 1.25m, Output = 10.00m, Cached = 0.13m },
                ["gpt-5.1-codex-max"] = new() { Input = 1.25m, Output = 10.00m, Cached = 0.13m },
                ["gpt-5.2"] = new() { Input = 1.75m, Output = 14.00m, Cached = 0.18m },
                ["gpt-5.2-codex"] = new() { Input = 1.75m, Output = 14.00m, Cached = 0.18m },
                ["gpt-5.3-codex"] = new() { Input = 1.75m, Output = 14.00m, Cached = 0.18m },
            },
        };
    }

    private static AiPricingService Build(AiPricingOptions? options = null) =>
        new(
            Options.Create(options ?? BuildOptions()),
            NullLogger<AiPricingService>.Instance);

    [Theory]
    [InlineData("gpt-4.1", 1_000_000, 0, 0, 2.00)]         // 1M uncached input @ $2
    [InlineData("gpt-4.1-mini", 1_000_000, 0, 0, 0.40)]    // 1M uncached input @ $0.40
    [InlineData("gpt-5.1", 1_000_000, 0, 0, 1.25)]
    [InlineData("gpt-5.1-chat", 1_000_000, 0, 0, 1.25)]
    [InlineData("gpt-5.1-codex-mini", 1_000_000, 0, 0, 1.25)]
    [InlineData("gpt-5.1-codex-max", 1_000_000, 0, 0, 1.25)]
    [InlineData("gpt-5.2", 1_000_000, 0, 0, 1.75)]
    [InlineData("gpt-5.2-codex", 1_000_000, 0, 0, 1.75)]
    [InlineData("gpt-5.3-codex", 1_000_000, 0, 0, 1.75)]
    public void CalculateUsd_One_Million_Uncached_Input_Tokens(
        string model, int prompt, int cached, int completion, double expectedUsd)
    {
        var service = Build();
        var result = service.CalculateUsd(model, prompt, cached, completion);
        Assert.Equal((decimal)expectedUsd, result);
    }

    [Theory]
    [InlineData("gpt-4.1", 0, 0, 1_000_000, 8.00)]
    [InlineData("gpt-4.1-mini", 0, 0, 1_000_000, 1.60)]
    [InlineData("gpt-5.1", 0, 0, 1_000_000, 10.00)]
    [InlineData("gpt-5.2", 0, 0, 1_000_000, 14.00)]
    public void CalculateUsd_One_Million_Output_Tokens(
        string model, int prompt, int cached, int completion, double expectedUsd)
    {
        var service = Build();
        var result = service.CalculateUsd(model, prompt, cached, completion);
        Assert.Equal((decimal)expectedUsd, result);
    }

    [Theory]
    [InlineData("gpt-4.1", 1_000_000, 1_000_000, 0, 0.50)]        // All cached
    [InlineData("gpt-5.1", 1_000_000, 1_000_000, 0, 0.13)]
    [InlineData("gpt-5.2", 1_000_000, 1_000_000, 0, 0.18)]
    public void CalculateUsd_Fully_Cached_Input_Uses_Cached_Rate(
        string model, int prompt, int cached, int completion, double expectedUsd)
    {
        var service = Build();
        var result = service.CalculateUsd(model, prompt, cached, completion);
        Assert.Equal((decimal)expectedUsd, result);
    }

    [Fact]
    public void CalculateUsd_Mixed_Tokens_Splits_Input_Between_Rates()
    {
        // gpt-4.1: 300k uncached input @ $2 = $0.60,
        //          200k cached input @ $0.50 = $0.10,
        //          100k completion @ $8 = $0.80.
        // Total: $1.50.
        var service = Build();
        var result = service.CalculateUsd(
            "gpt-4.1",
            promptTokens: 500_000,
            cachedPromptTokens: 200_000,
            completionTokens: 100_000);
        Assert.Equal(1.50m, result);
    }

    [Fact]
    public void CalculateUsd_Zero_Tokens_Returns_Zero()
    {
        var service = Build();
        Assert.Equal(0m, service.CalculateUsd("gpt-4.1", 0, 0, 0));
    }

    [Theory]
    [InlineData(-1, 0, 0)]
    [InlineData(0, -1, 0)]
    [InlineData(0, 0, -1)]
    public void CalculateUsd_Rejects_Negative_Counts(int prompt, int cached, int completion)
    {
        var service = Build();
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            service.CalculateUsd("gpt-4.1", prompt, cached, completion));
    }

    [Fact]
    public void CalculateUsd_Rejects_Cached_Exceeding_Prompt()
    {
        var service = Build();
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            service.CalculateUsd("gpt-4.1",
                promptTokens: 100, cachedPromptTokens: 200, completionTokens: 0));
    }

    [Fact]
    public void CalculateUsd_Unknown_Model_Falls_Back_To_Gpt_5_1_Rates()
    {
        var service = Build();

        var unknown = service.CalculateUsd(
            "gpt-brand-new",
            promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0);
        var known = service.CalculateUsd(
            "gpt-5.1",
            promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0);

        Assert.Equal(known, unknown);
    }

    [Fact]
    public void CalculateUsd_Null_Model_Falls_Back_To_Gpt_5_1_Rates()
    {
        var service = Build();

        var result = service.CalculateUsd(
            null,
            promptTokens: 1_000_000, cachedPromptTokens: 0, completionTokens: 0);
        Assert.Equal(1.25m, result);
    }

    [Fact]
    public void CalculateUsd_Missing_Fallback_Key_Returns_Zero()
    {
        // Misconfigured appsettings: the fallback key doesn't exist.
        // Must not crash — callers see €0 + a logged error.
        var opts = new AiPricingOptions
        {
            UsdToEurRate = 0.92m,
            Models = new Dictionary<string, ModelRates>
            {
                ["gpt-4.1"] = new() { Input = 2m, Output = 8m, Cached = 0.5m },
            },
        };
        var service = new AiPricingService(Options.Create(opts),
            NullLogger<AiPricingService>.Instance);
        var result = service.CalculateUsd("unknown", 1_000_000, 0, 1_000_000);
        Assert.Equal(0m, result);
    }

    [Fact]
    public void ConvertToEur_Default_Rate()
    {
        var service = Build();
        // 1.25 USD × 0.92 = 1.15 EUR — the plan's sanity-check value.
        var eur = service.ConvertToEur(1.25m);
        Assert.Equal(1.15m, eur);
    }

    [Fact]
    public void ConvertToEur_Custom_Rate()
    {
        var service = Build(BuildOptions(usdToEurRate: 1.0m));
        Assert.Equal(10m, service.ConvertToEur(10m));
    }

    [Fact]
    public void ConvertToEur_Zero_Rate_Produces_Zero()
    {
        // Operator can zero the rate to hide EUR from the dashboard.
        var service = Build(BuildOptions(usdToEurRate: 0m));
        Assert.Equal(0m, service.ConvertToEur(100m));
    }

    [Fact]
    public void UsdToEurRate_Exposes_The_Configured_Value()
    {
        var service = Build(BuildOptions(usdToEurRate: 0.85m));
        Assert.Equal(0.85m, service.UsdToEurRate);
    }
}
