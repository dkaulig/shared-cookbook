namespace SharedCookbook.Api.Services;

/// <summary>
/// REL-4 — canonical catalogue of stable, machine-readable error codes
/// emitted by every 4xx / 5xx response from the API.
///
/// <para>Consumers (REL-3 i18n frontend, future mobile apps, REL-5
/// cross-app error classifier) key off these values to decide how to
/// surface an error + which localised string to render. The codes are
/// <b>stable contracts</b>: renaming or deleting a code is a breaking
/// API change and must be announced in the release notes.</para>
///
/// <para>Rules:</para>
/// <list type="bullet">
/// <item><c>snake_case</c>, ASCII-only. No dots, no spaces, no
/// capitals. Use underscores to separate words
/// (<c>version_mismatch</c>, not <c>version.mismatch</c>).</item>
/// <item>Codes are short, descriptive, and scope-free — the HTTP
/// status carries the 4xx-vs-5xx bucket; the code names the specific
/// failure.</item>
/// <item>When two endpoints emit the same concept (e.g. "resource
/// missing"), prefer reusing an existing code. Add a new one only
/// when the <i>meaning</i> genuinely differs (e.g. <c>not_found</c> vs
/// <c>recipe_not_found</c> when the caller has to branch on resource
/// type for its UI).</item>
/// <item>Wire shape mirrored by the TypeScript <c>ApiError</c> in
/// <c>@shared-cookbook/shared</c> (<c>packages/shared/src/types/auth.ts</c>).
/// The Python extractor's <c>ai_disabled</c> code is listed here for
/// cross-layer reference even though the Python side owns its own
/// emission (REL-7).</item>
/// </list>
/// </summary>
public static class ErrorCodes
{
    // ── Validation (400) ─────────────────────────────────────────────

    /// <summary>A single field's value is out of range / malformed.
    /// HTTP 400. Pair with <c>fieldName</c> when one specific field is
    /// at fault.</summary>
    public const string InvalidValue = "invalid_value";

    /// <summary>A required field was absent or blank. HTTP 400. Pair
    /// with <c>fieldName</c>.</summary>
    public const string MissingField = "missing_field";

    /// <summary>Multiple required fields were absent or blank. HTTP
    /// 400. Used when listing a single <c>fieldName</c> would hide
    /// several missing inputs.</summary>
    public const string MissingFields = "missing_fields";

    /// <summary>The request payload failed validation — generic 400
    /// where the caller doesn't need a <c>fieldName</c> hint (malformed
    /// JSON, cross-field rule violation, domain-guard exception).</summary>
    public const string InvalidInput = "invalid_input";

    /// <summary>Request payload was not parseable JSON / wrong content
    /// type. HTTP 400.</summary>
    public const string InvalidBody = "invalid_body";

    /// <summary>A semantic constraint on a URL / source identifier
    /// failed (e.g. non-http(s) scheme, malformed Uri). HTTP 400.</summary>
    public const string InvalidUrl = "invalid_url";

    /// <summary>A query parameter was out of range (page / page_size /
    /// sort / query). HTTP 400.</summary>
    public const string InvalidQuery = "invalid_query";

    /// <summary>Pagination page index is below 1 or above the list
    /// bound. HTTP 400.</summary>
    public const string InvalidPage = "invalid_page";

    /// <summary>Pagination page size is out of bounds. HTTP 400.</summary>
    public const string InvalidPageSize = "invalid_page_size";

    /// <summary>Sort-order token is not in the endpoint's allowlist.
    /// HTTP 400.</summary>
    public const string InvalidSort = "invalid_sort";

    /// <summary>A tag id referenced by the caller is unknown or from a
    /// different group. HTTP 400.</summary>
    public const string InvalidTag = "invalid_tag";

    /// <summary>A category / enum value was unknown. HTTP 400.</summary>
    public const string InvalidCategory = "invalid_category";

    /// <summary>A supplied group id is empty / malformed. HTTP 400.</summary>
    public const string InvalidGroup = "invalid_group";

    /// <summary>A supplied source URL is invalid (e.g. reimport with
    /// non-http scheme persisted in DB). HTTP 400.</summary>
    public const string InvalidSourceUrl = "invalid_source_url";

    /// <summary>A staged photo id is missing / not a valid GUID. HTTP
    /// 400.</summary>
    public const string InvalidStagedPhotoId = "invalid_staged_photo_id";

    /// <summary>A signed photo URL failed the signing check. HTTP
    /// 400.</summary>
    public const string InvalidPhotoUrl = "invalid_photo_url";

    /// <summary>A chat-session title is missing / too long. HTTP
    /// 400.</summary>
    public const string InvalidTitle = "invalid_title";

    /// <summary>Content of a chat turn is empty. HTTP 400.</summary>
    public const string InvalidContent = "invalid_content";

    /// <summary>Content of a chat turn exceeds the per-message length
    /// cap. HTTP 400.</summary>
    public const string ContentTooLong = "content_too_long";

    /// <summary>Chat session has no messages to forward to the
    /// extractor. HTTP 400.</summary>
    public const string MessagesRequired = "messages_required";

    /// <summary>Display-name length / character constraint violation.
    /// HTTP 400.</summary>
    public const string DisplayNameInvalid = "displayname_invalid";

    /// <summary>Password update violates the policy (too short, no
    /// digit, etc.). HTTP 400.</summary>
    public const string PasswordRejected = "password_rejected";

    /// <summary>New and confirmation password do not match. HTTP
    /// 400.</summary>
    public const string PasswordMismatch = "password_mismatch";

    /// <summary>New password is identical to the current password.
    /// HTTP 400.</summary>
    public const string PasswordUnchanged = "password_unchanged";

    /// <summary>Invite token missing from the signup request. HTTP
    /// 400.</summary>
    public const string InviteTokenMissing = "invite_token_missing";

    /// <summary>Invite token is unknown. HTTP 400.</summary>
    public const string InviteNotFound = "invite_not_found";

    /// <summary>Invite token is expired or already consumed. HTTP
    /// 400.</summary>
    public const string InviteInvalid = "invite_invalid";

    /// <summary>Password-reset token is expired / malformed. HTTP
    /// 400.</summary>
    public const string InvalidToken = "invalid_token";

    /// <summary>Password-reset attempt failed at the Identity layer
    /// (token mismatch / policy). HTTP 400.</summary>
    public const string ResetFailed = "reset_failed";

    /// <summary>Email already registered. HTTP 400.</summary>
    public const string EmailTaken = "email_taken";

    /// <summary>Invited user id is unknown. HTTP 400.</summary>
    public const string UserNotFound = "user_not_found";

    /// <summary>User is already a member of the target group. HTTP
    /// 400.</summary>
    public const string AlreadyMember = "already_member";

    /// <summary>A pending invite already exists for this (group,
    /// user). HTTP 400.</summary>
    public const string InvitePending = "invite_pending";

    /// <summary>Invite is not in the Pending state (already accepted /
    /// declined). HTTP 400.</summary>
    public const string InviteNotPending = "invite_not_pending";

    /// <summary>Group role transition would drop the last admin of a
    /// group. HTTP 400.</summary>
    public const string LastAdmin = "last_admin";

    /// <summary>Per-user "Private Sammlung" cannot be deleted or left.
    /// HTTP 400.</summary>
    public const string PrivateCollectionProtected = "private_collection_protected";

    /// <summary>Global / seed tag cannot be deleted via the endpoint.
    /// HTTP 400.</summary>
    public const string GlobalTagProtected = "global_tag_protected";

    /// <summary>A tag with the same name already exists in this
    /// group. HTTP 400. Emitted as a Conflict-semantic 400 rather than
    /// 409 to match the legacy shape tests assert on.</summary>
    public const string TagExists = "tag_exists";

    /// <summary>File missing on a multipart photo upload. HTTP
    /// 400.</summary>
    public const string FileMissing = "file_missing";

    /// <summary>Uploaded file exceeds the per-request byte cap. HTTP
    /// 400.</summary>
    public const string FileTooLarge = "file_too_large";

    /// <summary>Uploaded file's MIME type is not in the allowlist.
    /// HTTP 400.</summary>
    public const string UnsupportedMediaType = "unsupported_media_type";

    /// <summary>Recipe has reached its maximum allowed photos. HTTP
    /// 400.</summary>
    public const string PhotoLimitReached = "photo_limit_reached";

    /// <summary>The cover-photo id is not part of the set the caller
    /// is promoting in this request. HTTP 400.</summary>
    public const string CoverNotInStagedSet = "cover_not_in_staged_set";

    /// <summary>A staged photo was not found. HTTP 400.</summary>
    public const string StagedPhotoNotFound = "staged_photo_not_found";

    /// <summary>Cover staged photo does not belong to the caller.
    /// HTTP 400.</summary>
    public const string CoverWrongOwner = "cover_wrong_owner";

    /// <summary>Cover staged photo is not attached to this recipe's
    /// origin import. HTTP 400.</summary>
    public const string CoverNotFromRecipeImport = "cover_not_from_recipe_import";

    /// <summary>Cover-swap path A: staged photo is not attached to
    /// this recipe. HTTP 400.</summary>
    public const string CoverNotOnRecipe = "cover_not_on_recipe";

    /// <summary>Cover-swap failed while copying the underlying blob.
    /// HTTP 400.</summary>
    public const string CoverCopyFailed = "cover_copy_failed";

    /// <summary>Recipe has no SourceUrl — reimport requested on a
    /// manual / chat-origin recipe. HTTP 400.</summary>
    public const string SourceUrlMissing = "source_url_missing";

    /// <summary>Reimport requested on a recipe whose origin was
    /// photos (no URL to re-fetch). HTTP 400.</summary>
    public const string PhotoImportReimportNotSupported = "photo_import_reimport_not_supported";

    /// <summary>/api/imports only serves the caller's own rows;
    /// <c>mine=false</c> is rejected. HTTP 400.</summary>
    public const string MineRequired = "mine_required";

    /// <summary>Photo batch was empty. HTTP 400.</summary>
    public const string PhotosRequired = "photos_required";

    /// <summary>Photo batch exceeded the per-import cap. HTTP
    /// 400.</summary>
    public const string TooManyPhotos = "too_many_photos";

    /// <summary>ISO week-start parameter was not a valid
    /// <c>YYYY-MM-DD</c> date. HTTP 400.</summary>
    public const string WeekstartInvalidFormat = "weekstart_invalid_format";

    /// <summary>Week-start parameter resolved to a day other than
    /// Monday. HTTP 400.</summary>
    public const string WeekstartNotMonday = "weekstart_not_monday";

    /// <summary>A meal-plan parent slot id was not found. HTTP
    /// 400.</summary>
    public const string ParentNotFound = "parent_not_found";

    /// <summary>A meal-plan parent slot id references a slot that
    /// lives on a different plan. HTTP 400.</summary>
    public const string ParentCrossPlan = "parent_cross_plan";

    /// <summary>A meal-plan parent assignment would form a cycle.
    /// HTTP 400.</summary>
    public const string ParentCycle = "parent_cycle";

    /// <summary>Slot references a recipe that is not in the plan's
    /// group. HTTP 400.</summary>
    public const string RecipeNotInGroup = "recipe_not_in_group";

    /// <summary>Copy-from source plan is identical to the target
    /// plan. HTTP 400.</summary>
    public const string CopySamePlan = "copy_same_plan";

    /// <summary>LANG-2 — translate request asked for the recipe's
    /// source language; nothing to translate. HTTP 400. The frontend
    /// hides the Translate button when
    /// <c>recipe.sourceLanguage === ui-language</c> so this defends a
    /// tampered request rather than a normal user click.</summary>
    public const string AlreadyInLanguage = "already_in_language";

    // ── Auth (401 / 403) ─────────────────────────────────────────────

    /// <summary>Caller has no valid authentication. HTTP 401.
    /// Typically emitted as a bare <c>Results.Unauthorized()</c> (no
    /// body); this const exists for the paths that DO write a
    /// structured body.</summary>
    public const string Unauthorized = "unauthorized";

    /// <summary>Caller is authenticated but lacks permission for this
    /// resource. HTTP 403.</summary>
    public const string Forbidden = "forbidden";

    /// <summary>Login failed — email or password invalid, OR account
    /// locked out. The message MUST stay identical across all three
    /// paths so an attacker can't distinguish "wrong password" from
    /// "user doesn't exist" from "account locked". HTTP 401.</summary>
    public const string InvalidCredentials = "invalid_credentials";

    /// <summary>Caller is not a group member on an endpoint that
    /// requires membership. HTTP 403.</summary>
    public const string NotAMember = "not_a_member";

    /// <summary>Caller does not own the target resource (e.g. staged
    /// photo). HTTP 403.</summary>
    public const string NotOwner = "not_owner";

    // ── Not-found (404) ──────────────────────────────────────────────

    /// <summary>Generic resource-missing. HTTP 404. Prefer a more
    /// specific code (e.g. <see cref="RecipeNotFound"/>,
    /// <see cref="ImportNotFound"/>) when the client has to branch on
    /// resource type.</summary>
    public const string NotFound = "not_found";

    /// <summary>Target recipe was not found or is soft-deleted. HTTP
    /// 404.</summary>
    public const string RecipeNotFound = "recipe_not_found";

    /// <summary>Target group was not found or is soft-deleted. HTTP
    /// 404.</summary>
    public const string GroupNotFound = "group_not_found";

    /// <summary>Target import was not found. HTTP 404.</summary>
    public const string ImportNotFound = "import_not_found";

    /// <summary>Config key not recognised. HTTP 404.</summary>
    public const string ConfigKeyNotFound = "config_key_not_found";

    /// <summary>Meal-plan was not found. HTTP 404.</summary>
    public const string MealplanNotFound = "mealplan_not_found";

    /// <summary>Shopping list was not found. HTTP 404.</summary>
    public const string ShoppingListNotFound = "shopping_list_not_found";

    /// <summary>Shopping-list item was not found. HTTP 404.</summary>
    public const string ShoppingItemNotFound = "shopping_item_not_found";

    /// <summary>Meal-plan slot was not found. HTTP 404.</summary>
    public const string SlotNotFound = "slot_not_found";

    /// <summary>Source plan for copy-from operation was not found.
    /// HTTP 404.</summary>
    public const string SourceNotFound = "source_not_found";

    // ── Conflict (409) ───────────────────────────────────────────────

    /// <summary>Optimistic-concurrency check failed — the client's
    /// If-Match ETag or version field is stale. HTTP 409. The body
    /// carries a <c>current</c> projection so the UI can reconcile
    /// without an extra GET.</summary>
    public const string VersionMismatch = "version_mismatch";

    /// <summary>Copy-from target plan is not empty. HTTP 409.</summary>
    public const string CopyTargetNotEmpty = "copy_target_not_empty";

    // ── Gone (410) ───────────────────────────────────────────────────

    /// <summary>Import candidates were reaped by the 7-day sweep.
    /// HTTP 410. Distinct from 404 so the client can show the
    /// "no longer available" message and stop polling.</summary>
    public const string CandidatesExpired = "candidates_expired";

    // ── Payload / proxy-shape (413 / 400 via proxy) ──────────────────

    /// <summary>Upstream Python extractor reported 413 Payload Too
    /// Large. HTTP 413.</summary>
    public const string PayloadTooLarge = "payload_too_large";

    /// <summary>Generic 4xx from the Python extractor that the API
    /// couldn't classify further. HTTP whatever Python returned.</summary>
    public const string ExtractorClientError = "extractor_client_error";

    // ── Rate-limit (429) ─────────────────────────────────────────────

    /// <summary>Request exceeded a rate-limiter policy (login,
    /// generate, etc.). HTTP 429. Currently emitted by the ASP.NET
    /// <c>RateLimiter</c> middleware as a bare 429 without a
    /// structured body; this code is reserved for endpoints that emit
    /// a body explicitly.</summary>
    public const string RateLimited = "rate_limited";

    /// <summary>Import batch rate-limit (reserved for REL-0b /
    /// abuse-controls). HTTP 429.</summary>
    public const string ImportRateLimited = "import_rate_limited";

    // ── Server (500) ─────────────────────────────────────────────────

    /// <summary>Unhandled server-side error. HTTP 500. Message is a
    /// fixed generic string — raw exception text never reaches the
    /// wire (see <see cref="GlobalExceptionHandler"/>).</summary>
    public const string InternalError = "internal_error";

    /// <summary>Python extractor returned 401 (HMAC drift) — masked
    /// as an internal error so HMAC state doesn't leak. HTTP
    /// 500.</summary>
    public const string ExtractorInternal = "extractor_internal";

    // ── Service-unavailable (502 / 503) ──────────────────────────────

    /// <summary>Feature was disabled by an admin via the
    /// <c>ExtractorConfigReader</c> kill switch. HTTP 503.</summary>
    public const string FeatureDisabled = "feature_disabled";

    /// <summary>Generic service-unavailable. HTTP 503.</summary>
    public const string ServiceUnavailable = "service_unavailable";

    /// <summary>AI features are globally disabled in the deployment
    /// config (REL-7 OSS flag). HTTP 503. Emitted from the Python
    /// extractor side; listed here for cross-layer reference so the
    /// frontend uses the same i18n key.</summary>
    public const string AiDisabled = "ai_disabled";

    /// <summary>Azure / LLM backend is temporarily unreachable or
    /// rate-limited. HTTP 503.</summary>
    public const string AiServiceUnavailable = "ai_service_unavailable";

    /// <summary>Python extractor returned a surprise / malformed 5xx.
    /// HTTP 502.</summary>
    public const string ExtractorBadGateway = "extractor_bad_gateway";

    /// <summary>Transport-level failure reaching the Python extractor
    /// (connection refused, timeout, DNS). HTTP 502.</summary>
    public const string ExtractorUnreachable = "extractor_unreachable";
}
