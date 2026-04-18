using System.Text;
using System.Threading.RateLimiting;
using Amazon.Runtime;
using Amazon.S3;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Identity;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ── Logging: structured JSON via Serilog, request-id enriched ─────────
builder.Host.UseSerilog((ctx, services, cfg) => cfg
    .ReadFrom.Configuration(ctx.Configuration)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("App", "FamilienKochbuch.Api")
    .WriteTo.Console());

// ── Options ───────────────────────────────────────────────────────────
builder.Services.Configure<JwtOptions>(builder.Configuration.GetSection(JwtOptions.SectionName));
// Honour the JWT_SIGNING_KEY env var if set (docker-compose wires it in).
builder.Services.PostConfigure<JwtOptions>(opts =>
{
    var envKey = builder.Configuration["JWT_SIGNING_KEY"]
                 ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY");
    if (!string.IsNullOrWhiteSpace(envKey))
        opts.SigningKey = envKey;
});

builder.Services.Configure<AppOptions>(builder.Configuration.GetSection(AppOptions.SectionName));

builder.Services.AddSingleton(TimeProvider.System);

// ── EF Core + Identity ────────────────────────────────────────────────
// In Testing env the WebApplicationFactory registers its own SQLite-backed
// AppDbContext via ConfigureTestServices; skip the Postgres registration
// here so EF doesn't fault with 'two database providers'.
if (!builder.Environment.IsEnvironment("Testing"))
{
    builder.Services.AddDbContext<AppDbContext>(opts =>
        opts.UseNpgsql(builder.Configuration.GetConnectionString("Postgres")));
}

builder.Services.AddIdentityCore<User>(opts =>
    {
        opts.User.RequireUniqueEmail = true;
        opts.Password.RequireDigit = false;
        opts.Password.RequireLowercase = false;
        opts.Password.RequireUppercase = false;
        opts.Password.RequireNonAlphanumeric = false;
        opts.Password.RequiredLength = 8;
    })
    .AddRoles<IdentityRole<Guid>>()
    .AddEntityFrameworkStores<AppDbContext>()
    .AddDefaultTokenProviders();

builder.Services.AddScoped<IPasswordHasher<User>, Argon2idPasswordHasher>();
builder.Services.AddScoped<TokenService>();
builder.Services.AddScoped<SeedDataService>();
builder.Services.AddScoped<IEmailSender, NoOpEmailSender>();
builder.Services.AddScoped<IPrivateCollectionService, PrivateCollectionService>();

// ── Photo storage (SeaweedFS via S3-compatible gateway) ──────────────
builder.Services.Configure<PhotoStorageOptions>(builder.Configuration.GetSection(PhotoStorageOptions.SectionName));
if (!builder.Environment.IsEnvironment("Testing"))
{
    builder.Services.AddSingleton<IAmazonS3>(sp =>
    {
        var opts = sp.GetRequiredService<IOptions<PhotoStorageOptions>>().Value;
        var config = new AmazonS3Config
        {
            ServiceURL = opts.Endpoint,
            ForcePathStyle = true, // SeaweedFS requires path-style addressing.
        };
        var creds = new BasicAWSCredentials(opts.AccessKey, opts.SecretKey);
        return new AmazonS3Client(creds, config);
    });
    builder.Services.AddScoped<IPhotoStorage, SeaweedFsPhotoStorage>();
}

// ── Auth (JWT Bearer) ─────────────────────────────────────────────────
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
// Configure JwtBearer options via the strongly-typed JwtOptions so the
// test host's UseSetting("Jwt:SigningKey", ...) flows through after the
// Program.cs host is built.
builder.Services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
    .Configure<IOptions<JwtOptions>>((jwtBearer, jwtOpts) =>
    {
        var jwt = jwtOpts.Value;
        jwtBearer.MapInboundClaims = false;
        jwtBearer.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwt.Issuer,
            ValidateAudience = true,
            ValidAudience = jwt.Audience,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey)),
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
builder.Services.AddAuthorization();

// ── CORS (dev): open to local Vite + Caddy ────────────────────────────
const string CorsPolicy = "FamilienKochbuchDev";
builder.Services.AddCors(opts =>
    opts.AddPolicy(CorsPolicy, p => p
        .WithOrigins("http://localhost", "http://localhost:5173")
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials()));

// ── Rate limiting: login = 5/min per IP ───────────────────────────────
// Partition key is the client IP. The per-user brute-force counterpart
// lives in the endpoint handler via Identity's AccessFailedCount / lockout
// (wired in later). Reading the email out of the request body for a more
// granular IP+email partition would require buffering the body inside the
// partition-key factory, which the sync RateLimitPartition<string> factory
// cannot await safely — so we stay with IP and rely on account lockout
// for the per-user limit.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(RateLimitPolicies.Login, httpContext =>
    {
        // In the Testing env the TestServer always reports RemoteIpAddress=null,
        // so rate-limiting would collapse every test into one bucket. Skip
        // rate-limiting in tests and trust the dedicated RateLimit test
        // (LoginRateLimit_After_5_Attempts_Returns_429) to exercise the path.
        if (httpContext.RequestServices.GetRequiredService<IHostEnvironment>()
                .IsEnvironment("Testing") &&
            httpContext.Request.Headers["X-Test-Disable-RateLimit"] == "true")
        {
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");
        }

        var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: ip,
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });
});

var app = builder.Build();

app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
});

app.UseSerilogRequestLogging();
app.UseCors(CorsPolicy);
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapHealthEndpoints();
app.MapAuthEndpoints();
app.MapInviteEndpoints();
app.MapGroupEndpoints();
app.MapRecipeEndpoints();

// ── Migrate + seed on startup (skipped in Testing environment) ────────
if (!app.Environment.IsEnvironment("Testing"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    var seeder = scope.ServiceProvider.GetRequiredService<SeedDataService>();
    await seeder.SeedAsync();

    // Ensure the SeaweedFS bucket exists — idempotent, best-effort.
    var s3 = scope.ServiceProvider.GetRequiredService<IAmazonS3>();
    var photoOpts = scope.ServiceProvider.GetRequiredService<IOptions<PhotoStorageOptions>>().Value;
    var photoLog = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    await SeaweedFsPhotoStorage.EnsureBucketAsync(s3, photoOpts, photoLog);
}

app.Run();

// Required for WebApplicationFactory<T> in tests.
public partial class Program;

/// <summary>Named rate-limit policies used across auth endpoints.</summary>
internal static class RateLimitPolicies
{
    public const string Login = "login";
}

/// <summary>Strongly-typed options for non-auth app config.</summary>
internal class AppOptions
{
    public const string SectionName = "App";
    public string FrontendBaseUrl { get; set; } = "http://localhost";
}
