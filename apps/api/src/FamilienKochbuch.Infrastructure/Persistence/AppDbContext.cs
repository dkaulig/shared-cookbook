using System.Text.Json;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Domain.Enums;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

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
    public DbSet<Recipe> Recipes => Set<Recipe>();
    public DbSet<Ingredient> Ingredients => Set<Ingredient>();
    public DbSet<RecipeStep> RecipeSteps => Set<RecipeStep>();
    public DbSet<Tag> Tags => Set<Tag>();
    public DbSet<RecipeTag> RecipeTags => Set<RecipeTag>();

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

        // ── Recipes ─────────────────────────────────────────────────

        builder.Entity<Recipe>(e =>
        {
            e.HasKey(r => r.Id);
            e.Property(r => r.Title)
                .IsRequired()
                .HasMaxLength(Recipe.TitleMaxLength);
            e.Property(r => r.Description).HasMaxLength(Recipe.DescriptionMaxLength);
            e.Property(r => r.SourceUrl).HasMaxLength(Recipe.SourceUrlMaxLength);
            e.Property(r => r.SourceType).HasConversion<int>();

            // Photos are stored as a JSON array in a single column. Works on
            // both Postgres (jsonb-friendly text) and SQLite, no provider-
            // specific column type needed. The ValueComparer teaches EF how
            // to detect list mutations for change tracking.
            var photoConverter = new ValueConverter<List<string>, string>(
                v => JsonSerializer.Serialize(v, PhotoJsonOptions),
                v => JsonSerializer.Deserialize<List<string>>(v, PhotoJsonOptions) ?? new List<string>());
            var photoComparer = new ValueComparer<List<string>>(
                (a, b) => (a ?? new()).SequenceEqual(b ?? new()),
                v => v.Aggregate(0, (hash, item) => HashCode.Combine(hash, item.GetHashCode())),
                v => v.ToList());
            e.Property(r => r.Photos)
                .HasConversion(photoConverter)
                .Metadata.SetValueComparer(photoComparer);

            e.HasIndex(r => r.GroupId);
            e.HasIndex(r => r.CreatedAt);
            e.HasIndex(r => r.DeletedAt);

            e.HasOne<Group>()
                .WithMany()
                .HasForeignKey(r => r.GroupId)
                // S3: Group deletion is always soft-delete today; S6 may add
                // hard delete semantics. Use Restrict to force an explicit
                // decision about orphaned recipes rather than surprise-cascade.
                .OnDelete(DeleteBehavior.Restrict);

            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(r => r.CreatedByUserId)
                .OnDelete(DeleteBehavior.Restrict);

            e.HasMany(r => r.Ingredients)
                .WithOne()
                .HasForeignKey(i => i.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasMany(r => r.Steps)
                .WithOne()
                .HasForeignKey(s => s.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasMany(r => r.RecipeTags)
                .WithOne()
                .HasForeignKey(rt => rt.RecipeId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<Ingredient>(e =>
        {
            e.HasKey(i => i.Id);
            e.Property(i => i.Name).IsRequired().HasMaxLength(Ingredient.NameMaxLength);
            e.Property(i => i.Unit).HasMaxLength(Ingredient.UnitMaxLength);
            e.Property(i => i.Note).HasMaxLength(Ingredient.NoteMaxLength);
            e.Property(i => i.Quantity).HasColumnType("numeric(12,3)");
            e.HasIndex(i => i.RecipeId);
            e.HasIndex(i => new { i.RecipeId, i.Position }).IsUnique();
        });

        builder.Entity<RecipeStep>(e =>
        {
            e.HasKey(s => s.Id);
            e.Property(s => s.Content).IsRequired().HasMaxLength(RecipeStep.ContentMaxLength);
            e.HasIndex(s => s.RecipeId);
            e.HasIndex(s => new { s.RecipeId, s.Position }).IsUnique();
        });

        builder.Entity<Tag>(e =>
        {
            e.HasKey(t => t.Id);
            e.Property(t => t.Name).IsRequired().HasMaxLength(Tag.NameMaxLength);
            e.Property(t => t.Category).HasConversion<int>();

            // Unique across (Name, Category, GroupId). GroupId IS NULL is a
            // single distinct bucket in Postgres's default unique-index
            // semantics, which is exactly what we want: two global tags
            // with the same (Name, Category) collide, but one global + one
            // group-scoped with the same (Name, Category) do not.
            e.HasIndex(t => new { t.Name, t.Category, t.GroupId }).IsUnique();

            e.HasOne<Group>()
                .WithMany()
                .HasForeignKey(t => t.GroupId)
                .OnDelete(DeleteBehavior.Cascade);

            e.HasOne<User>()
                .WithMany()
                .HasForeignKey(t => t.CreatedByUserId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<RecipeTag>(e =>
        {
            e.HasKey(rt => new { rt.RecipeId, rt.TagId });
            e.HasOne<Tag>()
                .WithMany()
                .HasForeignKey(rt => rt.TagId)
                .OnDelete(DeleteBehavior.Cascade);
            // Recipe ↔ RecipeTag cascade is set on the Recipe entity above
            // to keep the aggregate root as the single source of truth.
        });
    }

    private static readonly JsonSerializerOptions PhotoJsonOptions = new()
    {
        WriteIndented = false,
    };
}
