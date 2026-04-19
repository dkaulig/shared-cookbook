using FamilienKochbuch.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// EF Core mapping for <see cref="ChatUsageLog"/>. Stores the kind
/// enum as <c>int</c> to survive renames; indexes cover the two
/// admin-dashboard query shapes: "per-user spend over a period" and
/// "per-model spend over a period".
/// </summary>
internal sealed class ChatUsageLogConfiguration : IEntityTypeConfiguration<ChatUsageLog>
{
    public void Configure(EntityTypeBuilder<ChatUsageLog> e)
    {
        e.HasKey(c => c.Id);

        e.Property(c => c.Kind).HasConversion<int>();

        e.Property(c => c.SessionId)
            .IsRequired()
            .HasMaxLength(ChatUsageLog.SessionIdMaxLength);

        e.Property(c => c.ModelDeployment)
            .IsRequired()
            .HasMaxLength(ChatUsageLog.ModelDeploymentMaxLength);

        // Admin aggregates slice by user over a date range.
        e.HasIndex(c => new { c.UserId, c.CreatedAt });
        // And by model over a date range.
        e.HasIndex(c => new { c.ModelDeployment, c.CreatedAt });

        // FK to the owning user — Restrict so the user lifecycle
        // forces an explicit decision about retained usage logs
        // rather than a surprise cascade that loses audit data.
        e.HasOne<User>()
            .WithMany()
            .HasForeignKey(c => c.UserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
