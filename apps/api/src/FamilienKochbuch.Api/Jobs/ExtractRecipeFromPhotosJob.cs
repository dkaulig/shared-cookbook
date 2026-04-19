using System.Text.Json;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Hangfire;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Jobs;

/// <summary>
/// Hangfire job that drives a photos-based recipe extraction.
///
/// Mirrors <see cref="ExtractRecipeFromUrlJob"/> — same signer, same
/// HttpClient, same status-transition shape — but POSTs to
/// <c>/extract/photos</c> with the ordered list of signed photo URLs
/// that the user uploaded to SeaweedFS. Transport + retry logic lives
/// on <see cref="PythonExtractorRunner"/>; this class only loads the
/// import, validates the transit payload, and hands off.
///
/// The job trusts the enqueue step to have populated
/// <c>ResultJson</c> as a JSON array of strings. That contract is
/// private — only the enqueue endpoint writes it. The job rejects
/// missing / malformed input loudly.
/// </summary>
[AutomaticRetry(Attempts = 3)]
public class ExtractRecipeFromPhotosJob
{
    private readonly AppDbContext _db;
    private readonly PythonExtractorRunner _runner;
    private readonly IOptions<AppOptions> _appOptions;

    public ExtractRecipeFromPhotosJob(
        AppDbContext db,
        PythonExtractorRunner runner,
        IOptions<AppOptions> appOptions)
    {
        _db = db;
        _runner = runner;
        _appOptions = appOptions;
    }

    public async Task ExecuteAsync(Guid importId, CancellationToken ct)
    {
        var import = await _db.RecipeImports.SingleOrDefaultAsync(i => i.Id == importId, ct)
            ?? throw new InvalidOperationException(
                $"RecipeImport {importId} not found; was it deleted before the job ran?");

        if (import.Source != ImportSource.Photos)
            throw new InvalidOperationException(
                $"RecipeImport {importId} has source {import.Source}; expected Photos.");

        // For Photos, the enqueue step stashes the ordered URL list in
        // ResultJson pre-run; the job reads it, then forwards. MarkDone
        // overwrites ResultJson with the real result so the transit
        // list doesn't linger.
        var photoUrls = ReadPhotoUrls(import);

        // BUG-011: the frontend's signed-URL builder produces
        // path-absolute URLs like "/api/photos/recipes/{id}?sig=…&exp=…"
        // because they're meant to be consumed by the same browser that
        // already knows the origin. .NET happily forwards them — but
        // Python's ExtractPhotosRequest declares `photo_urls: list[HttpUrl]`,
        // and pydantic's HttpUrl is strict about absolute http(s) schemes,
        // so a relative path round-trips as 422. Worse: even if the
        // string parsed, Azure Vision needs a publicly fetchable URL,
        // not a docker-internal one. So before we hand off, we promote
        // each URL to absolute by prefixing the configured FrontendBaseUrl
        // (in prod: https://${CADDY_DOMAIN}). Already-absolute URLs pass
        // through unchanged so existing tests + manual callers stay
        // backward-compatible.
        var absoluteUrls = photoUrls
            .Select(u => AbsolutizePhotoUrl(u, _appOptions.Value.FrontendBaseUrl))
            .ToList();

        await _runner.RunAsync(
            import,
            relativeUrl: "/extract/photos",
            buildBody: i => new
            {
                photo_urls = absoluteUrls,
                hint = new
                {
                    group_id = i.GroupId.ToString("D"),
                    user_id = i.UserId.ToString("D"),
                },
            },
            ct);
    }

    /// <summary>
    /// Promotes a frontend-issued signed photo URL to an absolute
    /// http(s) URL that pydantic <c>HttpUrl</c> accepts and Azure Vision
    /// can fetch. Leaves URLs that already start with <c>http://</c> or
    /// <c>https://</c> unchanged so externally-supplied URLs (and
    /// existing tests) continue to work.
    ///
    /// Path-absolute inputs (<c>/api/photos/...</c>) are concatenated
    /// onto <paramref name="frontendBaseUrl"/> after stripping a trailing
    /// slash so the result has exactly one separator. Path-relative or
    /// blank inputs throw — they shouldn't reach this point because
    /// <c>IsSignedPhotoUrl</c> already rejected them at the enqueue
    /// edge, but failing loud here makes any future regression
    /// observable in the Hangfire failure log instead of silently
    /// producing a 404 on Azure's side.
    /// </summary>
    internal static string AbsolutizePhotoUrl(string raw, string frontendBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(raw))
            throw new InvalidOperationException("photo URL is blank.");

        if (raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return raw;
        }

        if (!raw.StartsWith('/'))
            throw new InvalidOperationException(
                $"photo URL '{raw}' is neither absolute http(s) nor path-absolute; "
                + "the enqueue endpoint should have rejected it.");

        if (string.IsNullOrWhiteSpace(frontendBaseUrl))
            throw new InvalidOperationException(
                "App:FrontendBaseUrl is not configured; cannot promote relative photo URL "
                + $"'{raw}' to absolute. Set the env var App__FrontendBaseUrl.");

        return $"{frontendBaseUrl.TrimEnd('/')}{raw}";
    }

    private static IReadOnlyList<string> ReadPhotoUrls(RecipeImport import)
    {
        if (string.IsNullOrWhiteSpace(import.ResultJson))
            throw new InvalidOperationException(
                $"RecipeImport {import.Id}: photos payload missing — the enqueue step must "
                + "seed ResultJson with the ordered photo URL list.");

        try
        {
            using var doc = JsonDocument.Parse(import.ResultJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException(
                    $"RecipeImport {import.Id}: photos payload must be a JSON array of URLs.");

            var urls = new List<string>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.String)
                    throw new InvalidOperationException(
                        $"RecipeImport {import.Id}: photo URLs must be strings.");
                var url = el.GetString();
                if (string.IsNullOrWhiteSpace(url))
                    throw new InvalidOperationException(
                        $"RecipeImport {import.Id}: photo URL is blank.");
                urls.Add(url!);
            }
            if (urls.Count == 0)
                throw new InvalidOperationException(
                    $"RecipeImport {import.Id}: photo URL list is empty.");
            return urls;
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                $"RecipeImport {import.Id}: photos payload is not valid JSON.", ex);
        }
    }
}
