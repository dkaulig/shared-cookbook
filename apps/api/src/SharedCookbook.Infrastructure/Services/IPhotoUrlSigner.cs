namespace SharedCookbook.Infrastructure.Services;

/// <summary>
/// Produces a signed, time-bounded proxy URL for a given storage path.
/// Implemented in the Api layer (mirroring hoppr's signing service) so
/// that Infrastructure does not need to know about the signing primitives
/// or the JWT secret.
/// </summary>
public interface IPhotoUrlSigner
{
    /// <summary>Returns <c>/api/photos/{path}?sig=...&amp;exp=...</c> for the given storage path.</summary>
    string SignPhotoUrl(string path);
}
