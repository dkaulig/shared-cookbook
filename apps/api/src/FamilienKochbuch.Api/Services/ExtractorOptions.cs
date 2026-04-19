namespace FamilienKochbuch.Api.Services;

/// <summary>
/// Strongly-typed settings for the .NET → Python extractor bridge
/// introduced in P2-5.
///
/// <list type="bullet">
/// <item><c>SharedSecret</c> — HMAC key shared with the Python service;
/// comes from <c>EXTRACTOR_SHARED_SECRET</c> env var.</item>
/// <item><c>BaseUrl</c> — HTTP root of the Python service (e.g.
/// <c>http://python-extractor:8000</c>).</item>
/// </list>
///
/// Keep this boring — no derived properties, no validation magic. The
/// secret is loaded via config binding; ensure logging config never
/// serialises the whole options object.
/// </summary>
public class ExtractorOptions
{
    public const string SectionName = "PythonExtractor";

    /// <summary>HMAC-SHA256 shared secret for the .NET ↔ Python bridge.
    /// Must match <c>EXTRACTOR_SHARED_SECRET</c> on the Python side.</summary>
    public string SharedSecret { get; set; } = string.Empty;

    /// <summary>Base URL of the Python extractor service. Used by the
    /// named <c>"python-extractor"</c> HttpClient.</summary>
    public string BaseUrl { get; set; } = "http://python-extractor:8000";
}
