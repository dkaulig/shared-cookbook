using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SharedCookbook.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    /// <summary>
    /// GR1 — seeds seven global Komponente tags so users can categorise
    /// isolated sub-recipes (Pizzateig, Tomatensauce, Dressings, …).
    ///
    /// <para>
    /// No schema changes. Only the <see cref="TagCategory.Komponente"/>
    /// enum member was added, and Tags.Category is stored as a plain int
    /// column, so Postgres needs no migration — the new ordinal (7) is
    /// accepted without a DDL change.
    /// </para>
    ///
    /// <para>
    /// GUIDs are stable (a0000007-…) so re-running the migration on an
    /// already-seeded DB is idempotent on the (Name, Category, GroupId)
    /// uniqueness index — the index rejects duplicates on natural keys,
    /// which is what we want for migrations that run once per DB.
    /// </para>
    /// </summary>
    public partial class AddKomponenteTagCategory : Migration
    {
        // TagCategory.Komponente. Duplicated as a literal here (instead of
        // importing the Domain enum) so migrations stay insulated from
        // enum renames — EF best practice for historical migrations.
        private const int KomponenteCategory = 7;

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            var columns = new[] { "Id", "Name", "Category", "CreatedByUserId", "GroupId" };

            object[,] rows =
            {
                { new Guid("a0000007-0000-0000-0000-000000000001"), "Grundrezept", KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000002"), "Teig",        KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000003"), "Sauce",       KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000004"), "Glasur",      KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000005"), "Dressing",    KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000006"), "Beilage",     KomponenteCategory, null!, null! },
                { new Guid("a0000007-0000-0000-0000-000000000007"), "Topping",     KomponenteCategory, null!, null! },
            };

            migrationBuilder.InsertData(
                table: "Tags",
                columns: columns,
                values: rows);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Remove only the GR1 seed rows — leave the schema and the
            // pre-existing 30 global tags untouched.
            Guid[] ids =
            {
                new("a0000007-0000-0000-0000-000000000001"),
                new("a0000007-0000-0000-0000-000000000002"),
                new("a0000007-0000-0000-0000-000000000003"),
                new("a0000007-0000-0000-0000-000000000004"),
                new("a0000007-0000-0000-0000-000000000005"),
                new("a0000007-0000-0000-0000-000000000006"),
                new("a0000007-0000-0000-0000-000000000007"),
            };

            foreach (var id in ids)
            {
                migrationBuilder.DeleteData(
                    table: "Tags",
                    keyColumn: "Id",
                    keyValue: id);
            }
        }
    }
}
