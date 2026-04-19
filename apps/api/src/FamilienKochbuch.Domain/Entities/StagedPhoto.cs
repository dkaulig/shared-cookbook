namespace FamilienKochbuch.Domain.Entities;

/// <summary>
/// PF1 — tracks a photo that has been uploaded into SeaweedFS via the
/// staged-upload endpoint (<c>POST /api/recipes/photos/staged</c>) but
/// is not yet bound to a saved recipe.
///
/// Two consumers read this row:
/// <list type="bullet">
/// <item>The create-recipe endpoint, which "promotes" a list of staged
///   photos by copying the underlying blobs into the recipe's
///   namespace and then marking each row with
///   <see cref="PromotedAt"/> + <see cref="PromotedToRecipeId"/>.</item>
/// <item>The hourly Hangfire sweep job, which reaps blobs older than
///   24 hours that never got promoted (= the user abandoned the
///   import flow).</item>
/// </list>
///
/// The aggregate is intentionally minimal: ownership (so the promote
/// flow can verify the caller actually uploaded the photo), the
/// SeaweedFS key (so the sweep + promote can locate the blob), and the
/// promotion lifecycle (so we never double-promote).
/// </summary>
public sealed class StagedPhoto
{
    // EF-friendly parameterless ctor — private so domain construction
    // goes through the validating ctor below.
    private StagedPhoto() { }

    public StagedPhoto(
        Guid userId,
        string photoId,
        string signedUrl,
        string contentType,
        DateTimeOffset createdAt)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (string.IsNullOrWhiteSpace(photoId))
            throw new ArgumentException("PhotoId must not be blank.", nameof(photoId));
        if (string.IsNullOrWhiteSpace(signedUrl))
            throw new ArgumentException("SignedUrl must not be blank.", nameof(signedUrl));
        if (string.IsNullOrWhiteSpace(contentType))
            throw new ArgumentException("ContentType must not be blank.", nameof(contentType));

        Id = Guid.NewGuid();
        UserId = userId;
        PhotoId = photoId.Trim();
        SignedUrl = signedUrl.Trim();
        ContentType = contentType.Trim();
        CreatedAt = createdAt;
    }

    public Guid Id { get; private set; }
    public Guid UserId { get; private set; }

    /// <summary>The bare SeaweedFS storage key (e.g. <c>recipes/abc.jpg</c>).</summary>
    public string PhotoId { get; private set; } = string.Empty;

    /// <summary>The signed proxy URL captured at upload time. Kept around
    /// for diagnostics + the rare case the frontend needs to re-display
    /// the photo before promote without re-signing.</summary>
    public string SignedUrl { get; private set; } = string.Empty;

    /// <summary>MIME type captured from the multipart upload. Lets the
    /// promote step preserve the extension when copying the blob into
    /// the recipe namespace.</summary>
    public string ContentType { get; private set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Set the moment the photo is attached to a recipe. Stays
    /// <c>null</c> for the lifetime of an abandoned upload until the
    /// sweep job reaps the row.</summary>
    public DateTimeOffset? PromotedAt { get; private set; }

    /// <summary>Recipe that adopted this staged photo. <c>null</c> while
    /// <see cref="PromotedAt"/> is also <c>null</c>; both fields move
    /// together via <see cref="MarkPromoted"/>.</summary>
    public Guid? PromotedToRecipeId { get; private set; }

    /// <summary>
    /// Records the recipe that adopted this staged photo + the
    /// timestamp it happened. Idempotency is not allowed — callers must
    /// not double-promote, and an attempted second call is a programming
    /// bug (the create-recipe handler already filters
    /// <c>PromotedAt == null</c> before invoking this method).
    /// </summary>
    public void MarkPromoted(Guid recipeId, DateTimeOffset promotedAt)
    {
        if (recipeId == Guid.Empty)
            throw new ArgumentException("RecipeId must not be empty.", nameof(recipeId));
        if (PromotedAt is not null)
            throw new InvalidOperationException(
                $"StagedPhoto {Id} is already promoted to recipe {PromotedToRecipeId}.");

        PromotedToRecipeId = recipeId;
        PromotedAt = promotedAt;
    }
}
