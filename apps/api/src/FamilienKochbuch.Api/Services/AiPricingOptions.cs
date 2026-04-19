namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Strongly-typed settings for PF2 AI-cost accounting. Sourced from
/// <c>appsettings.json</c> under <c>AiPricing:*</c>; the user can tweak
/// the rates without a redeploy when Microsoft publishes new pricing.
///
/// Storage is always USD internally (Azure bills in USD even in EU
/// regions). <see cref="UsdToEurRate"/> converts for display.
/// </summary>
public class AiPricingOptions
{
    public const string SectionName = "AiPricing";

    /// <summary>Multiplier applied to USD totals to produce EUR for the
    /// admin dashboard. Default <c>0.92</c> tracks the long-run EUR/USD
    /// midpoint. Operators update this manually; no live-FX feed.</summary>
    public decimal UsdToEurRate { get; set; } = 0.92m;

    /// <summary>Per-deployment pricing table. Keys are the Azure
    /// deployment name (matches <see cref="Domain.Entities.RecipeImport.ModelDeployment"/>);
    /// values carry the three rates. Unknown deployments fall back to
    /// <c>gpt-5.1</c> (see <see cref="AiPricingService"/>).</summary>
    public Dictionary<string, ModelRates> Models { get; set; } = new();
}

/// <summary>
/// Per-1M-token USD rates for one Azure deployment. Mirrors the table
/// pinned in the PF2 plan doc. All three values are USD per 1 million
/// tokens.
/// </summary>
public class ModelRates
{
    /// <summary>USD per 1M input tokens at standard / non-cached rate.</summary>
    public decimal Input { get; set; }

    /// <summary>USD per 1M output tokens.</summary>
    public decimal Output { get; set; }

    /// <summary>USD per 1M input tokens that hit the prompt cache.</summary>
    public decimal Cached { get; set; }
}
