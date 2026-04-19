using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Services;

/// <summary>
/// AI-cost calculator. Applies the configured per-1M-token rates to
/// token counts surfaced by the Python extractor.
///
/// Storage is USD internally (matches Azure's billing unit); callers
/// convert to EUR via <see cref="ConvertToEur"/> at display time.
///
/// Unknown deployment names fall back to the <c>gpt-5.1</c> rates and
/// emit a single-line structured warning so operators notice when a
/// new deployment landed without a pricing-table update.
/// </summary>
public class AiPricingService
{
    /// <summary>Deployment name used as the fallback when the caller's
    /// model isn't in the pricing table. Chosen because the 5.1
    /// family's mid-tier rates don't grossly under- or over-bill
    /// compared with the 4.1 family or the codex family — so the
    /// fallback sum is directionally right even while someone
    /// investigates.</summary>
    public const string UnknownModelFallbackKey = "gpt-5.1";

    private readonly AiPricingOptions _options;
    private readonly ILogger<AiPricingService> _logger;

    public AiPricingService(IOptions<AiPricingOptions> options, ILogger<AiPricingService> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    /// <summary>Exposed so the admin endpoint can display the current
    /// rate without re-reading config.</summary>
    public decimal UsdToEurRate => _options.UsdToEurRate;

    /// <summary>
    /// Compute the USD cost for one LLM call.
    ///
    /// Formula: <c>(prompt - cached) / 1M * input_rate + cached / 1M *
    /// cached_rate + completion / 1M * output_rate</c>. "Prompt minus
    /// cached" avoids double-billing the cached-hit portion at both
    /// the input and cached rates.
    /// </summary>
    public decimal CalculateUsd(
        string? modelDeployment,
        int promptTokens,
        int cachedPromptTokens,
        int completionTokens)
    {
        if (promptTokens < 0) throw new ArgumentOutOfRangeException(nameof(promptTokens));
        if (cachedPromptTokens < 0) throw new ArgumentOutOfRangeException(nameof(cachedPromptTokens));
        if (completionTokens < 0) throw new ArgumentOutOfRangeException(nameof(completionTokens));
        if (cachedPromptTokens > promptTokens)
            throw new ArgumentOutOfRangeException(
                nameof(cachedPromptTokens),
                "Cached prompt tokens cannot exceed total prompt tokens.");

        var rates = ResolveRates(modelDeployment);
        var uncachedPrompt = promptTokens - cachedPromptTokens;

        // Keep the intermediate math at decimal precision so rounding
        // only happens once at the call site, not inside the helper.
        const decimal million = 1_000_000m;
        var inputCost = uncachedPrompt / million * rates.Input;
        var cachedCost = cachedPromptTokens / million * rates.Cached;
        var outputCost = completionTokens / million * rates.Output;
        return inputCost + cachedCost + outputCost;
    }

    /// <summary>Convert a USD value into EUR using the configured
    /// <see cref="AiPricingOptions.UsdToEurRate"/>.</summary>
    public decimal ConvertToEur(decimal usd) => usd * _options.UsdToEurRate;

    private ModelRates ResolveRates(string? modelDeployment)
    {
        if (!string.IsNullOrWhiteSpace(modelDeployment)
            && _options.Models.TryGetValue(modelDeployment, out var rates))
        {
            return rates;
        }

        // Warn-once per process would be nicer, but the call rate is
        // low (per-request) and the structured event is what ops
        // search for. Logging every call is acceptable.
        _logger.LogWarning(
            "AiPricingService.UnknownModelFallback {ModelName}",
            modelDeployment ?? "<null>");

        if (_options.Models.TryGetValue(UnknownModelFallbackKey, out var fallback))
            return fallback;

        // If the fallback key is also missing (misconfigured
        // appsettings), return zero rates — the row shows up as €0 on
        // the dashboard rather than crashing the admin page. Log at
        // Error so ops see the double-miss.
        _logger.LogError(
            "AiPricingService.FallbackMissing {FallbackKey} — no pricing data will be applied.",
            UnknownModelFallbackKey);
        return new ModelRates();
    }
}
