using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>
/// <see cref="IPhotoStorage"/> backed by SeaweedFS's S3-compatible gateway.
/// Constructed once per scope; the underlying <see cref="IAmazonS3"/> is a
/// singleton registered in <c>Program.cs</c>.
/// </summary>
public class SeaweedFsPhotoStorage(
    IAmazonS3 s3,
    IOptions<PhotoStorageOptions> options,
    ILogger<SeaweedFsPhotoStorage> logger) : IPhotoStorage
{
    private readonly PhotoStorageOptions _options = options.Value;

    public async Task<string> UploadAsync(
        Stream content,
        string contentType,
        string originalFileName,
        CancellationToken ct = default)
    {
        if (content is null) throw new ArgumentNullException(nameof(content));
        if (string.IsNullOrWhiteSpace(contentType))
            throw new ArgumentException("Content type must not be blank.", nameof(contentType));

        var extension = DeriveExtension(contentType, originalFileName);
        var key = $"{Guid.NewGuid():N}{extension}";

        var request = new PutObjectRequest
        {
            BucketName = _options.Bucket,
            Key = key,
            InputStream = content,
            ContentType = contentType,
            DisablePayloadSigning = true,
        };

        await s3.PutObjectAsync(request, ct);
        logger.LogInformation("Uploaded photo {Key} ({ContentType}) to bucket {Bucket}",
            key, contentType, _options.Bucket);

        var baseUrl = _options.PublicBaseUrl.TrimEnd('/');
        return $"{baseUrl}/{_options.Bucket}/{key}";
    }

    public async Task DeleteAsync(string url, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(url))
            throw new ArgumentException("URL must not be blank.", nameof(url));

        if (!TryParseObjectKey(url, out var key))
        {
            logger.LogWarning("Photo URL {Url} is not managed by SeaweedFsPhotoStorage; skipping delete.", url);
            return;
        }

        try
        {
            await s3.DeleteObjectAsync(new DeleteObjectRequest
            {
                BucketName = _options.Bucket,
                Key = key,
            }, ct);
            logger.LogInformation("Deleted photo {Key} from bucket {Bucket}", key, _options.Bucket);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // Idempotent — already gone.
        }
    }

    private bool TryParseObjectKey(string url, out string key)
    {
        key = string.Empty;
        var prefix = $"{_options.PublicBaseUrl.TrimEnd('/')}/{_options.Bucket}/";
        if (!url.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return false;

        key = url[prefix.Length..];
        return key.Length > 0;
    }

    private static string DeriveExtension(string contentType, string originalFileName)
    {
        var lowered = contentType.ToLowerInvariant();
        var ext = lowered switch
        {
            "image/jpeg" or "image/jpg" => ".jpg",
            "image/png" => ".png",
            "image/webp" => ".webp",
            _ => string.Empty,
        };

        if (ext.Length > 0) return ext;

        var fromName = Path.GetExtension(originalFileName);
        return string.IsNullOrWhiteSpace(fromName) ? string.Empty : fromName;
    }

    /// <summary>
    /// Ensures the configured bucket exists — idempotent, safe to call on
    /// every startup. Used by <c>Program.cs</c> after wiring the DI graph.
    /// </summary>
    public static async Task EnsureBucketAsync(
        IAmazonS3 s3,
        PhotoStorageOptions options,
        ILogger logger,
        CancellationToken ct = default)
    {
        try
        {
            var buckets = await s3.ListBucketsAsync(ct);
            if (buckets.Buckets.Any(b => string.Equals(b.BucketName, options.Bucket, StringComparison.Ordinal)))
                return;
            await s3.PutBucketAsync(options.Bucket, ct);
            logger.LogInformation("Created SeaweedFS bucket {Bucket}", options.Bucket);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not ensure SeaweedFS bucket {Bucket} — photo upload may fail.",
                options.Bucket);
        }
    }
}
