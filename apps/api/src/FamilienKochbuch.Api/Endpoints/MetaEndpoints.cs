using FamilienKochbuch.Api.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// REL-7 — anonymous feature-probe endpoint driving the frontend's
/// AI feature gate.
///
/// The web app needs to know, before the user logs in, whether this
/// instance has AI enabled so it can hide import-from-photo / chat
/// CTAs and (eventually) switch the URL-import page into raw-text
/// pre-fill mode. A tiny unauthenticated endpoint is the cleanest
/// surface — no secrets leak (Azure key / Ollama URL stay server-side)
/// and the frontend's <c>useFeatures()</c> hook can fetch it once per
/// session.
///
/// The flags derive from <see cref="AiFeatureOptions"/> which reads
/// the <c>Ai:Enabled</c> + <c>Ai:Provider</c> config keys. Source of
/// truth is docker-compose's <c>AI_ENABLED</c> / <c>LLM_PROVIDER</c>
/// env vars — the same pair the Python extractor consumes.
/// </summary>
public static class MetaEndpoints
{
    public static void MapMetaEndpoints(this WebApplication app)
    {
        app.MapGet("/api/meta/features", GetFeaturesAsync)
            .WithTags("Meta")
            .AllowAnonymous();
    }

    // ── DTOs ────────────────────────────────────────────────────────

    /// <summary>Shape returned by <c>GET /api/meta/features</c>.
    /// Mirrored on the web side by the <c>useFeatures</c> hook +
    /// <c>FeatureGate</c> wrapper.</summary>
    public sealed record FeaturesResponse(AiFeaturesDto Ai);

    /// <summary>AI capability snapshot.</summary>
    /// <param name="Enabled">Master switch. When <c>false</c>, every
    /// entry in <paramref name="Features"/> is <c>false</c> except
    /// <c>JsonldImport</c>.</param>
    /// <param name="Provider">Active backend (<c>azure</c> /
    /// <c>ollama</c>) or <c>null</c> when AI is off.</param>
    /// <param name="Features">Per-capability flags so the frontend can
    /// gate individual CTAs without hard-coding "if provider is
    /// disabled".</param>
    public sealed record AiFeaturesDto(
        bool Enabled,
        string? Provider,
        AiFeatureFlagsDto Features);

    /// <summary>Individual capability flags. REL-8 (JSON-LD parser) is
    /// always-on because it doesn't depend on AI — the branch lives
    /// upstream of the LLM call in the Python pipeline.</summary>
    /// <param name="UrlImport">URL-import with AI structuring. False
    /// when AI is off; the pipeline falls back to raw-text pre-fill
    /// (REL-7 in combination with REL-8 JSON-LD).</param>
    /// <param name="JsonldImport">JSON-LD-based blog import. Always
    /// <c>true</c> — REL-8 runs ahead of any LLM call and doesn't need
    /// credentials.</param>
    /// <param name="VideoImport">Video-URL import. Gated behind AI
    /// because even the "raw-text pre-fill" path needs Whisper, which
    /// the REL-7 lifespan guard only pre-fetches when AI is on.</param>
    /// <param name="PhotoImport">Import from photo (vision LLM). Gated
    /// on AI.</param>
    /// <param name="Chat">Rezept-aus-Chat feature. Gated on AI.</param>
    public sealed record AiFeatureFlagsDto(
        bool UrlImport,
        bool JsonldImport,
        bool VideoImport,
        bool PhotoImport,
        bool Chat);

    // ── Handler ─────────────────────────────────────────────────────

    internal static IResult GetFeaturesAsync(
        [FromServices] IOptionsSnapshot<AiFeatureOptions> options,
        HttpResponse response)
    {
        var opts = options.Value;
        var provider = opts.ResolveProvider();
        var enabled = provider is not null;

        var flags = new AiFeatureFlagsDto(
            UrlImport: enabled,
            // REL-8 — JSON-LD works without any credentials. Kept
            // true unconditionally so the frontend can always show
            // "URL importieren" for blog URLs, even on AI-off
            // installs. REL-8 may flip this to a runtime probe later
            // (e.g. if the JSON-LD feature itself were togglable),
            // but for now it's a static guarantee.
            JsonldImport: true,
            // Ambiguity resolution from REL-7 design-doc: Whisper is
            // local CPU (not "AI" strictly) but the prefetch is
            // opt-in behind --profile ai. Video without AI structuring
            // would need manual transcribing anyway — gate behind AI.
            VideoImport: enabled,
            PhotoImport: enabled,
            Chat: enabled);

        var body = new FeaturesResponse(new AiFeaturesDto(
            Enabled: enabled,
            Provider: provider,
            Features: flags));

        // Short cache so browsers / the service worker don't hammer
        // the endpoint on every focus, but the TTL stays short enough
        // that a docker-compose restart propagates to clients within a
        // minute. No auth → safe to let the browser cache at all.
        response.Headers["Cache-Control"] = "public, max-age=60";
        return Results.Ok(body);
    }
}
