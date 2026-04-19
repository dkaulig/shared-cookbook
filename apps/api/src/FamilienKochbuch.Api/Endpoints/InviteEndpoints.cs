using System.Security.Claims;
using System.Security.Cryptography;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// App-level invite endpoints. Any authenticated user can create an invite;
/// anonymous visitors can preview an invite to see who invited them; only
/// the creator or a global admin can revoke.
/// </summary>
public static class InviteEndpoints
{
    /// <summary>Lifetime from the PRD (§10.1): 14 days, single-use.</summary>
    internal static readonly TimeSpan InviteLifetime = TimeSpan.FromDays(14);

    public record CreateInviteRequest(string? Email = null);
    public record CreateInviteResponse(Guid Id, string Token, string InviteUrl, DateTimeOffset ExpiresAt);
    public record InvitePreviewResponse(bool Valid, DateTimeOffset ExpiresAt, string? InviterDisplayName);

    public static void MapInviteEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/invites/app").WithTags("Invites");

        group.MapPost("/", CreateAsync).RequireAuthorization();
        group.MapGet("/{token}", PreviewAsync).AllowAnonymous();
        group.MapDelete("/{id:guid}", RevokeAsync).RequireAuthorization();
    }

    private static async Task<IResult> CreateAsync(
        CreateInviteRequest body,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        IOptions<AppOptions> appOptions,
        IEmailSender emailSender,
        ILogger<AppInvite> logger,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId))
            return Results.Unauthorized();

        var now = clock.GetUtcNow();
        var token = GenerateToken();
        var invite = new AppInvite(
            token: token,
            createdByUserId: userId,
            email: body.Email,
            createdAt: now,
            expiresAt: now.Add(InviteLifetime));

        db.AppInvites.Add(invite);
        await db.SaveChangesAsync(ct);

        var url = $"{appOptions.Value.FrontendBaseUrl.TrimEnd('/')}/signup?token={token}";

        // PF3 — best-effort mail delivery. The invite row is authoritative;
        // a mail failure must not 5xx the endpoint so the inviter can still
        // copy the returned URL manually.
        if (!string.IsNullOrWhiteSpace(invite.Email))
        {
            try
            {
                var inviterDisplayName = principal.FindFirstValue("displayName")
                                          ?? principal.FindFirstValue(ClaimTypes.Name)
                                          ?? "Jemand";
                await emailSender.SendAppInviteAsync(
                    toEmail: invite.Email,
                    inviterDisplayName: inviterDisplayName,
                    acceptUrl: url,
                    personalNote: null,
                    ct: ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "App-invite mail delivery failed for inviteId={InviteId}; inviter can still share the link manually.",
                    invite.Id);
            }
        }

        return Results.Ok(new CreateInviteResponse(invite.Id, token, url, invite.ExpiresAt));
    }

    private static async Task<IResult> PreviewAsync(
        string token,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        var invite = await db.AppInvites.SingleOrDefaultAsync(i => i.Token == token, ct);
        if (invite is null)
            return FamilienResults.NotFound("invite_not_found", "Einladung wurde nicht gefunden.");

        var creator = await db.Users
            .Where(u => u.Id == invite.CreatedByUserId)
            .Select(u => u.DisplayName)
            .SingleOrDefaultAsync(ct);

        return Results.Ok(new InvitePreviewResponse(
            Valid: invite.IsValid(clock.GetUtcNow()),
            ExpiresAt: invite.ExpiresAt,
            InviterDisplayName: creator));
    }

    private static async Task<IResult> RevokeAsync(
        Guid id,
        ClaimsPrincipal principal,
        AppDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        if (!TryGetUserId(principal, out var userId))
            return Results.Unauthorized();

        var invite = await db.AppInvites.SingleOrDefaultAsync(i => i.Id == id, ct);
        if (invite is null)
            return Results.NotFound();

        if (invite.CreatedByUserId != userId && !principal.IsAdmin())
            return Results.Forbid();

        // Soft-revoke by marking it used-by-self so IsValid becomes false.
        // (We deliberately don't hard-delete: keeps the audit trail intact.)
        if (invite.UsedByUserId is null)
            invite.MarkUsed(userId, clock.GetUtcNow());
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    private static bool TryGetUserId(ClaimsPrincipal principal, out Guid userId)
    {
        userId = Guid.Empty;
        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(sub, out userId);
    }

    internal static string GenerateToken()
    {
        // 64 hex chars = 32 random bytes — matches AppInvite.TokenLength (64).
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
