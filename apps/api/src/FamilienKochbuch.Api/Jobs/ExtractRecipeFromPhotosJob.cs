using System.Text.Json;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Hangfire;
using Microsoft.EntityFrameworkCore;

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

    public ExtractRecipeFromPhotosJob(AppDbContext db, PythonExtractorRunner runner)
    {
        _db = db;
        _runner = runner;
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

        await _runner.RunAsync(
            import,
            relativeUrl: "/extract/photos",
            buildBody: i => new
            {
                photo_urls = photoUrls,
                hint = new
                {
                    group_id = i.GroupId.ToString("D"),
                    user_id = i.UserId.ToString("D"),
                },
            },
            ct);
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
