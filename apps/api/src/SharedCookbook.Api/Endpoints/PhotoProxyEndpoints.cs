using System.Globalization;
using SharedCookbook.Api.Services;
using SharedCookbook.Infrastructure.Services;
using Microsoft.Extensions.Options;

namespace SharedCookbook.Api.Endpoints;

/// <summary>
/// Anonymous, signature-gated read proxy for recipe photos. Mirrors
/// hoppr's <c>GET /api/images/{**path}</c> but uses our "photos" domain
/// vocabulary. The bytes are fetched from the SeaweedFS filer over a
/// private docker-network HTTP client — SeaweedFS never speaks to the
/// outside world directly.
/// </summary>
public static class PhotoProxyEndpoints
{
    public static void MapPhotoProxyEndpoints(this WebApplication app)
    {
        app.MapGet("/api/photos/{**path}", async (
            string path,
            HttpContext ctx,
            IHttpClientFactory httpFactory,
            IOptions<PhotoStorageOptions> storageOptions,
            ImageSigningService signing) =>
        {
            var sig = ctx.Request.Query["sig"].FirstOrDefault();
            var expStr = ctx.Request.Query["exp"].FirstOrDefault();
            if (!long.TryParse(expStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var exp)
                || !signing.Validate(path, sig, exp))
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }

            var filerUrl = storageOptions.Value.FilerUrl.TrimEnd('/');
            var client = httpFactory.CreateClient(SeaweedFsPhotoStorage.FilerHttpClientName);
            try
            {
                using var response = await client.GetAsync($"{filerUrl}/{path}");
                if (!response.IsSuccessStatusCode)
                    return Results.NotFound();

                var contentType = response.Content.Headers.ContentType?.MediaType
                                  ?? "application/octet-stream";
                var bytes = await response.Content.ReadAsByteArrayAsync();

                // Signed URLs are time-limited already, but cache privately
                // for an hour so the frontend can hit browser-cache on
                // subsequent renders within the same signature window.
                ctx.Response.Headers.CacheControl = "private, max-age=3600";
                return Results.File(bytes, contentType, enableRangeProcessing: false);
            }
            catch (HttpRequestException)
            {
                return Results.NotFound();
            }
        })
        .AllowAnonymous()
        .WithTags("Photos");
    }
}
