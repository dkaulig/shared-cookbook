using FamilienKochbuch.Domain.Entities;
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
    }
}
