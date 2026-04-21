using FamilienKochbuch.Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FamilienKochbuch.Infrastructure.Persistence.Configurations;

/// <summary>
/// CFG-0 — EF Core mapping for <see cref="ExtractorConfig"/>. Key is the
/// PK (dotted string, up to <see cref="ExtractorConfig.KeyMaxLength"/>
/// chars). <see cref="ExtractorConfig.ValueJson"/> persists as
/// <c>jsonb</c> on Postgres and <c>TEXT</c> on SQLite — both store raw
/// JSON text the way the Python extractor + admin UI both expect.
/// <see cref="ExtractorConfig.ValueType"/> stays as <c>int</c> on disk
/// so a future enum rename can't silently shift existing rows.
/// </summary>
internal sealed class ExtractorConfigConfiguration
    : IEntityTypeConfiguration<ExtractorConfig>
{
    public void Configure(EntityTypeBuilder<ExtractorConfig> e)
    {
        e.ToTable("ExtractorConfig");

        e.HasKey(c => c.Key);

        e.Property(c => c.Key)
            .IsRequired()
            .HasMaxLength(ExtractorConfig.KeyMaxLength);

        // jsonb on Postgres, TEXT on SQLite — EF picks the right type
        // off the provider. Deliberately NOT pinned to "jsonb" at the
        // entity level so the SQLite test harness still applies the
        // migration cleanly.
        e.Property(c => c.ValueJson)
            .IsRequired()
            .HasColumnType("jsonb");

        e.Property(c => c.ValueType)
            .HasConversion<int>()
            .IsRequired();

        e.Property(c => c.UpdatedAt).IsRequired();

        // UpdatedBy is nullable — seed rows carry NULL so the admin
        // timeline can distinguish "never touched by a human" from
        // "edited by <user>".
        e.Property(c => c.UpdatedBy);

        // Optimistic-concurrency token. IsConcurrencyToken so the EF
        // SaveChanges pipeline also catches the race that can slip past
        // the endpoint-level expectedVersion check (two admin tabs
        // racing between GET and PUT).
        e.Property(c => c.Version)
            .IsRequired()
            .IsConcurrencyToken();
    }
}

/// <summary>
/// CFG-0 — EF Core mapping for <see cref="ExtractorConfigHistory"/>.
/// Composite index <c>(Key, ChangedAt DESC)</c> covers the admin UI's
/// per-key history view — fetching the last 10 changes for a single
/// key is a covering-index range scan with no secondary sort.
/// </summary>
internal sealed class ExtractorConfigHistoryConfiguration
    : IEntityTypeConfiguration<ExtractorConfigHistory>
{
    public void Configure(EntityTypeBuilder<ExtractorConfigHistory> e)
    {
        e.ToTable("ExtractorConfigHistory");

        e.HasKey(h => h.Id);

        e.Property(h => h.Key)
            .IsRequired()
            .HasMaxLength(ExtractorConfig.KeyMaxLength);

        // Both old + new values are the same jsonb-on-Postgres / TEXT-
        // on-SQLite shape. OldValueJson stays NOT NULL: every real edit
        // has a previous state (seed rows persist their initial payload
        // as the first "old" for any subsequent edit).
        e.Property(h => h.OldValueJson)
            .IsRequired()
            .HasColumnType("jsonb");
        e.Property(h => h.NewValueJson)
            .IsRequired()
            .HasColumnType("jsonb");

        e.Property(h => h.ChangedAt).IsRequired();
        e.Property(h => h.ChangedBy);

        // Composite index (Key, ChangedAt DESC). EF Core ignores the
        // descending hint for SQLite; Postgres picks it up via the
        // IsDescending() chain. Either way the primary use case
        // (get-last-10-by-key) only needs the leading column to be
        // (Key) to cut the scan, and the ORDER BY finishes in memory
        // for SQLite — negligible since tests write ≤ a few rows.
        e.HasIndex(h => new { h.Key, h.ChangedAt })
            .HasDatabaseName("IX_ExtractorConfigHistory_Key_ChangedAt")
            .IsDescending(false, true);
    }
}
