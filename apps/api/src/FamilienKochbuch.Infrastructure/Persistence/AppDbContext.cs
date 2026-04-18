using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace FamilienKochbuch.Infrastructure.Persistence;

/// <summary>
/// Primary EF Core context. Extends <see cref="IdentityDbContext{TUser,TRole,TKey}"/>
/// so ASP.NET Identity gets its own AspNet* tables (with Guid keys), and adds
/// the Familien-Kochbuch entities that live alongside Identity.
/// </summary>
public class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<User, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<AppInvite> AppInvites => Set<AppInvite>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<Group> Groups => Set<Group>();
    public DbSet<GroupMembership> GroupMemberships => Set<GroupMembership>();
    public DbSet<GroupInvite> GroupInvites => Set<GroupInvite>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<User>(e =>
        {
            e.Property(u => u.DisplayName)
                .IsRequired()
                .HasMaxLength(80);
            // NormalizedEmail already gets a unique index by Identity defaults;
            // we leave that intact.
        });

        builder.Entity<AppInvite>(e =>
        {
            e.HasKey(a => a.Id);
            e.Property(a => a.Token)
                .IsRequired()
                .HasMaxLength(AppInvite.TokenLength);
            e.HasIndex(a => a.Token).IsUnique();
            e.HasIndex(a => a.CreatedByUserId);
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(a => a.CreatedByUserId)
                .OnDelete(DeleteBehavior.Restrict);
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(a => a.UsedByUserId)
                .OnDelete(DeleteBehavior.SetNull);
            e.Property(a => a.Email).HasMaxLength(320);
        });

        builder.Entity<RefreshToken>(e =>
        {
            e.HasKey(r => r.Id);
            e.Property(r => r.TokenHash)
                .IsRequired()
                .HasMaxLength(128);
            e.HasIndex(r => r.TokenHash).IsUnique();
            e.HasIndex(r => r.UserId);
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(r => r.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<Group>(e =>
        {
            e.HasKey(g => g.Id);
            e.Property(g => g.Name)
                .IsRequired()
                .HasMaxLength(Group.NameMaxLength);
            e.Property(g => g.Description).HasMaxLength(Group.DescriptionMaxLength);
            e.Property(g => g.CoverImageUrl).HasMaxLength(500);
            e.Property(g => g.DefaultServings).HasColumnType("numeric(10,2)");
            e.HasIndex(g => g.CreatedAt);
        });

        builder.Entity<GroupMembership>(e =>
        {
            e.HasKey(m => new { m.UserId, m.GroupId });
            e.HasIndex(m => m.GroupId);
            e.Property(m => m.Role).HasConversion<int>();
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(m => m.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasOne<Group>()
                .WithMany()
                .HasForeignKey(m => m.GroupId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<GroupInvite>(e =>
        {
            e.HasKey(i => i.Id);
            e.Property(i => i.Status).HasConversion<int>();
            e.HasIndex(i => i.InvitedUserId);
            e.HasIndex(i => i.GroupId);
            // Filtered partial unique index: at most one Pending invite per
            // (GroupId, InvitedUserId) pair at a time. Accepted/Declined
            // rows stay for audit but don't block new Pending invites.
            // InviteStatus.Pending == 0 (see enum definition).
            e.HasIndex(i => new { i.GroupId, i.InvitedUserId })
                .HasFilter($"\"Status\" = {(int)InviteStatus.Pending}")
                .IsUnique()
                .HasDatabaseName("IX_GroupInvites_Pending_Unique");
            e.HasOne<Group>()
                .WithMany()
                .HasForeignKey(i => i.GroupId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(i => i.InvitedByUserId)
                .OnDelete(DeleteBehavior.Restrict);
            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(i => i.InvitedUserId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}
