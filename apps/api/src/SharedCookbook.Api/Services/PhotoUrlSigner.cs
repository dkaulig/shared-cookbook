using SharedCookbook.Infrastructure.Services;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Adapter that lets <see cref="Infrastructure.Services.IPhotoStorage"/>
/// request a signed proxy URL without taking a hard dependency on the
/// Api layer's <see cref="ImageSigningService"/>. The path convention
/// (<c>/api/photos/{path}</c>) is encoded once here so storage code
/// never has to remember it.
/// </summary>
public class PhotoUrlSigner : IPhotoUrlSigner
{
    private readonly ImageSigningService _signing;

    public PhotoUrlSigner(ImageSigningService signing)
    {
        _signing = signing;
    }

    public string SignPhotoUrl(string path)
        => _signing.SignUrl($"/api/photos/{path}", path);
}
