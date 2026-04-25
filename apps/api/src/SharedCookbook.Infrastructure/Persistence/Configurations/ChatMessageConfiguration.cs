using SharedCookbook.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace SharedCookbook.Infrastructure.Persistence.Configurations;

/// <summary>
/// CR1 — EF Core mapping for <see cref="ChatMessage"/>. Stores the
/// role enum as <c>int</c> (survives renames), indexes the
/// history-load hit (<c>SessionId ORDER BY CreatedAt ASC</c>), and
/// cascades delete from <see cref="ChatSession"/> so a session removal
/// reaps its message rows in a single tx.
///
/// The session-owning-user FK isn't enforced at the DB level (the
/// endpoint layer checks <c>ApplicationUser</c> ownership on every
/// request); only the in-context session → messages FK is — keeps the
/// migration cheap and avoids a cross-context Identity FK.
/// </summary>
internal sealed class ChatMessageConfiguration : IEntityTypeConfiguration<ChatMessage>
{
    public void Configure(EntityTypeBuilder<ChatMessage> e)
    {
        e.ToTable("ChatMessages");
        e.HasKey(m => m.Id);
        e.Property(m => m.SessionId).IsRequired();
        e.Property(m => m.Role).IsRequired().HasConversion<int>();
        e.Property(m => m.Content)
            .IsRequired()
            .HasMaxLength(ChatMessage.ContentMaxLength);
        e.Property(m => m.CreatedAt).IsRequired();

        // Message history hits (SessionId ORDER BY CreatedAt ASC).
        e.HasIndex(m => new { m.SessionId, m.CreatedAt })
            .HasDatabaseName("IX_ChatMessages_Session_CreatedAt");

        // Cascade-delete messages when a session goes away. The
        // session-owning-user FK is enforced in code (checking
        // ApplicationUser on the endpoint); a DB FK isn't worth the
        // cross-context weight — but the session → messages FK is
        // in-context and valuable.
        e.HasOne<ChatSession>()
            .WithMany()
            .HasForeignKey(m => m.SessionId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
