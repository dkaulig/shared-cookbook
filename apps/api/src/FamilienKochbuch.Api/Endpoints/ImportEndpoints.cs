using System.Security.Claims;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Api.Endpoints;

/// <summary>
/// Endpoints for the <see cref="RecipeImport"/> aggregate. P2-5 ships
/// the read-side status endpoint the frontend polls every 2 s during
/// an import:
/// <code>GET /api/imports/{importId}</code>
///
/// The user-facing enqueue endpoints live in P2-6 (proxy surface);
/// this slice stops at the status read.
/// </summary>
public static class ImportEndpoints
{
    public record ImportStatusResponse(
        Guid Id,
        string Source,
        string Status,
        int Progress,
        string? SourceUrl,
        string? Result,
        string? Error,
        DateTimeOffset CreatedAt,
        DateTimeOffset? CompletedAt);

    public static void MapImportEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/imports").WithTags("Imports");

        group.MapGet("/{importId:guid}", GetImportAsync)
            .RequireAuthorization();
    }

    private static async Task<IResult> GetImportAsync(
        Guid importId,
        HttpContext ctx,
        AppDbContext db,
        CancellationToken ct)
    {
        var callerId = ctx.User.FindFirstValue(System.IdentityModel.Tokens.Jwt.JwtRegisteredClaimNames.Sub);
        if (string.IsNullOrWhiteSpace(callerId) || !Guid.TryParse(callerId, out var callerGuid))
            return Results.Unauthorized();

        var isAdmin = string.Equals(
            ctx.User.FindFirstValue(AdminOnlyAuthorizationFilter.RoleClaimType),
            AdminOnlyAuthorizationFilter.AdminRoleClaimValue,
            StringComparison.Ordinal);

        var import = await db.RecipeImports.AsNoTracking()
            .SingleOrDefaultAsync(i => i.Id == importId, ct);
        if (import is null)
            return Results.NotFound();

        if (!isAdmin && import.UserId != callerGuid)
            return FamilienResults.Forbidden("forbidden", "Dieser Import gehört dir nicht.");

        return Results.Ok(new ImportStatusResponse(
            Id: import.Id,
            Source: import.Source.ToString(),
            Status: import.Status.ToString(),
            Progress: import.Progress,
            SourceUrl: import.SourceUrl,
            // ResultJson is surfaced only on Done (the enqueue side
            // uses ResultJson for transit data on Photos jobs; don't
            // leak that raw back to the caller while still running).
            Result: import.Status == ImportStatus.Done ? import.ResultJson : null,
            Error: import.ErrorMessage,
            CreatedAt: import.CreatedAt,
            CompletedAt: import.CompletedAt));
    }
}
