using FamilienKochbuch.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// CR1 — EF Core mapping for <see cref="ChatSession"/>. Indexes the
/// sessions-list UI hit (<c>UserId ORDER BY UpdatedAt DESC</c>) so the
/// "newest-active conversations first" view never needs a sort.
/// </summary>
internal sealed class ChatSessionConfiguration : IEntityTypeConfiguration<ChatSession>
{
    public void Configure(EntityTypeBuilder<ChatSession> e)
    {
        e.ToTable("ChatSessions");
        e.HasKey(s => s.Id);
        e.Property(s => s.UserId).IsRequired();
        e.Property(s => s.Title).HasMaxLength(ChatSession.TitleMaxLength);
        e.Property(s => s.MessageCount).IsRequired();
        e.Property(s => s.CreatedAt).IsRequired();
        e.Property(s => s.UpdatedAt).IsRequired();

        // Sessions-list UI hits (UserId ORDER BY UpdatedAt DESC).
        e.HasIndex(s => new { s.UserId, s.UpdatedAt })
            .HasDatabaseName("IX_ChatSessions_User_UpdatedAt");
    }
}
