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
        DateTimeOffset createdAt,
        string? sourceUrl = null,
        Guid? linkedImportId = null,
        int? candidateOrder = null)
    {
        if (userId == Guid.Empty)
            throw new ArgumentException("UserId must not be empty.", nameof(userId));
        if (string.IsNullOrWhiteSpace(photoId))
            throw new ArgumentException("PhotoId must not be blank.", nameof(photoId));
        if (string.IsNullOrWhiteSpace(signedUrl))
            throw new ArgumentException("SignedUrl must not be blank.", nameof(signedUrl));
        if (string.IsNullOrWhiteSpace(contentType))
            throw new ArgumentException("ContentType must not be blank.", nameof(contentType));
        // COVER-0 — LinkedImportId + CandidateOrder move together. Rows
        // with a candidate position must belong to an import (otherwise
        // the sweep's 7-day branch can't find the cohort), and rows
        // linked to an import must know their position (the grid renders
        // in CandidateOrder, not insertion order).
        if (linkedImportId is { } lii && lii == Guid.Empty)
            throw new ArgumentException(
                "LinkedImportId must not be empty.", nameof(linkedImportId));
        if (candidateOrder is int order && order < 0)
            throw new ArgumentOutOfRangeException(
                nameof(candidateOrder), order,
                "CandidateOrder must be >= 0 when present.");
        if ((linkedImportId is null) != (candidateOrder is null))
            throw new ArgumentException(
                "LinkedImportId and CandidateOrder must both be set or both null.",
                nameof(linkedImportId));

        Id = Guid.NewGuid();
        UserId = userId;
        PhotoId = photoId.Trim();
        SignedUrl = signedUrl.Trim();
        ContentType = contentType.Trim();
        CreatedAt = createdAt;
        SourceUrl = string.IsNullOrWhiteSpace(sourceUrl) ? null : sourceUrl.Trim();
        LinkedImportId = linkedImportId;
        CandidateOrder = candidateOrder;
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
    /// BUG-048 / COVER-0 — origin URL the photo was sourced from, when
    /// the row was produced by the candidate-download pipeline against
    /// a Python-extractor <c>recipe.candidate_thumbnails</c> entry.
    /// <c>null</c> for rows created by the user-facing staged-upload
    /// endpoint (where the user directly uploaded a file and no origin
    /// URL exists).
    ///
    /// Used by the reimport flow to dedupe — a repeat reimport of the
    /// same source URL must not re-stage the thumbnail if a previous
    /// reimport already promoted a StagedPhoto with this same origin
    /// onto the target recipe. Pure metadata: never surfaced to the
    /// frontend, never used to resolve the blob (<see cref="PhotoId"/>
    /// remains the only storage key).
    /// </summary>
    public string? SourceUrl { get; private set; }

    /// <summary>COVER-0 — when the staged photo was produced by the
    /// <see cref="Api.Services.CandidateAttacher"/> as one of the
    /// candidate thumbnails of an import, this is the parent
    /// <see cref="RecipeImport"/>'s id. Null for user-uploaded staged
    /// photos. Also toggles the sweep job's 7-day TTL branch — rows
    /// with <see cref="LinkedImportId"/> non-null are kept until
    /// 7 days post-creation (vs 24 h for manually-uploaded rows) so the
    /// "Cover ändern" flow on the recipe detail page has a usable
    /// window after the initial save.</summary>
    public Guid? LinkedImportId { get; private set; }

    /// <summary>COVER-0 — 0-indexed position within the cohort of
    /// candidates emitted by a single import. Mirrors
    /// <see cref="LinkedImportId"/> (both set or both null). The
    /// candidate-grid on the RecipeFormPage renders tiles in this
    /// order; gaps are allowed when some downloads failed mid-attach.</summary>
    public int? CandidateOrder { get; private set; }

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
