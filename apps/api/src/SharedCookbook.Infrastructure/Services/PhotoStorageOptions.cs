namespace SharedCookbook.Infrastructure.Services;

/// <summary>Strongly-typed config for <see cref="SeaweedFsPhotoStorage"/>.
/// Mirrors hoppr's <c>SeaweedFS:FilerUrl</c> convention — a single URL
/// pointing at the SeaweedFS filer REST endpoint on the internal docker
/// network.</summary>
public class PhotoStorageOptions
{
    public const string SectionName = "SeaweedFS";

    /// <summary>Filer REST endpoint (plain HTTP). Default targets the
    /// in-cluster service name used by docker-compose.</summary>
    public string FilerUrl { get; set; } = "http://seaweedfs:8333";
}
