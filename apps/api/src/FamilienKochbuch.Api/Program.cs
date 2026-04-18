using System.Text;
using System.Threading.RateLimiting;
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

// ── Auth (JWT Bearer) ─────────────────────────────────────────────────
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        var jwt = builder.Configuration.GetSection(JwtOptions.SectionName).Get<JwtOptions>()
                  ?? new JwtOptions();
        var signingKey = builder.Configuration["JWT_SIGNING_KEY"]
                         ?? Environment.GetEnvironmentVariable("JWT_SIGNING_KEY")
                         ?? jwt.SigningKey;
        options.MapInboundClaims = false;
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwt.Issuer,
            ValidateAudience = true,
            ValidAudience = jwt.Audience,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(signingKey)),
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

// ── Rate limiting: login = 5/min per IP+email ─────────────────────────
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy(RateLimitPolicies.Login, httpContext =>
    {
        var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var email = httpContext.Request.HasJsonContentType() && httpContext.Request.ContentLength > 0
            ? httpContext.Items.TryGetValue("login_email_key", out var keyObj) && keyObj is string k ? k : "anon"
            : "anon";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: $"{ip}|{email}",
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

// ── Migrate + seed on startup (skipped in Testing environment) ────────
if (!app.Environment.IsEnvironment("Testing"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    var seeder = scope.ServiceProvider.GetRequiredService<SeedDataService>();
    await seeder.SeedAsync();
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
