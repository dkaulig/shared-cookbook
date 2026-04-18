namespace FamilienKochbuch.Infrastructure.Services;

/// <summary>Strongly-typed config for <see cref="SeaweedFsPhotoStorage"/>.</summary>
public class PhotoStorageOptions
{
    public const string SectionName = "PhotoStorage";

    /// <summary>S3-compatible endpoint of the SeaweedFS gateway
    /// (e.g. <c>http://seaweedfs:8333</c>).</summary>
    public string Endpoint { get; set; } = "http://seaweedfs:8333";

    /// <summary>Bucket used for recipe photos. Created on startup if missing.</summary>
    public string Bucket { get; set; } = "recipe-photos";

    /// <summary>S3 access key. SeaweedFS accepts any non-empty value by default.</summary>
    public string AccessKey { get; set; } = "familien-kochbuch";

    /// <summary>S3 secret key. SeaweedFS accepts any non-empty value by default.</summary>
    public string SecretKey { get; set; } = "familien-kochbuch";

    /// <summary>Base URL used to construct the public link returned to clients.
    /// In dev this is the same as <see cref="Endpoint"/>; production uses a
    /// Caddy-fronted subdomain.</summary>
    public string PublicBaseUrl { get; set; } = "http://seaweedfs:8333";
}
