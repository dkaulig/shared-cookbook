using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace SharedCookbook.Infrastructure.Persistence;

/// <summary>
/// Used exclusively by <c>dotnet ef</c> tooling (<c>migrations add</c>,
/// <c>database update</c>) to spin up the context without needing the full
/// host. Runtime wiring goes through <c>Program.cs</c>.
/// </summary>
public class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(
                "Host=localhost;Database=familien_kochbuch;Username=app;Password=dev",
                b => b.MigrationsAssembly(typeof(DesignTimeDbContextFactory).Assembly.FullName))
            .Options;

        return new AppDbContext(options);
    }
}
