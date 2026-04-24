using System.Text;
using System.Threading.RateLimiting;
using FamilienKochbuch.Api.Endpoints;
using FamilienKochbuch.Api.Endpoints.MealPlanning;
using FamilienKochbuch.Api.Hubs;
using FamilienKochbuch.Api.Jobs;
using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Ai;
using FamilienKochbuch.Infrastructure.Identity;
using FamilienKochbuch.Infrastructure.Persistence;
using FamilienKochbuch.Infrastructure.Services;
using Hangfire;
using Hangfire.PostgreSql;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Diagnostics;
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

// REL-7 — AI feature-gate flags (consumed by /api/meta/features so the
// web frontend can hide import-from-photo / chat CTAs when the stack
// boots without AI). Bound from the ``Ai:`` config section; docker-
// compose forwards ``AI_ENABLED`` + ``LLM_PROVIDER`` from the shared
// .env via ``Ai__Enabled`` + ``Ai__Provider`` mirrors.
builder.Services.Configure<FamilienKochbuch.Api.Services.AiFeatureOptions>(
    builder.Configuration.GetSection(FamilienKochbuch.Api.Services.AiFeatureOptions.SectionName));

// P2-5 — Python extractor bridge config. SharedSecret comes from
// EXTRACTOR_SHARED_SECRET at runtime; appsettings carries the dev
// defaults. BaseUrl defaults to the internal docker hostname.
builder.Services.Configure<ExtractorOptions>(
    builder.Configuration.GetSection(ExtractorOptions.SectionName));
builder.Services.PostConfigure<ExtractorOptions>(opts =>
{
    var envSecret = Environment.GetEnvironmentVariable("EXTRACTOR_SHARED_SECRET");
    if (!string.IsNullOrWhiteSpace(envSecret))
        opts.SharedSecret = envSecret;
});

// AI pricing table + EUR conversion. Rates live in appsettings.json
// so the user can update them when Microsoft publishes new pricing
// without a redeploy.
builder.Services.Configure<AiPricingOptions>(
    builder.Configuration.GetSection(AiPricingOptions.SectionName));
builder.Services.AddSingleton<AiPricingService>();

builder.Services.AddSingleton(TimeProvider.System);

// ── EF Core + Identity ────────────────────────────────────────────────
// In Testing env the WebApplicationFactory registers its own SQLite-backed
// AppDbContext via ConfigureTestServices; skip the Postgres registration
// here so EF doesn't fault with 'two database providers'.
if (!builder.Environment.IsEnvironment("Testing"))
{
    builder.Services.AddDbContext<AppDbContext>(opts =>
        opts.UseNpgsql(builder.Configuration.GetConnectionString("Postgres")));

    // ── P2-5: Hangfire job orchestration (skipped in Testing env) ──
    // Dedicated "hangfire" schema in the same Postgres instance.
    // PrepareSchemaIfNecessary = true creates the Hangfire tables
    // idempotently on boot so there's no manual migration step.
    var pgConnection = builder.Configuration.GetConnectionString("Postgres")
        ?? throw new InvalidOperationException("ConnectionStrings:Postgres is required.");
    builder.Services.AddHangfire(cfg => cfg
        .SetDataCompatibilityLevel(CompatibilityLevel.Version_170)
        .UseSimpleAssemblyNameTypeSerializer()
        .UseRecommendedSerializerSettings()
        .UsePostgreSqlStorage(opts => opts.UseNpgsqlConnection(pgConnection),
            new PostgreSqlStorageOptions
            {
                SchemaName = "hangfire",
                PrepareSchemaIfNecessary = true,
            }));
    builder.Services.AddHangfireServer(opts =>
    {
        // Default cap at 2: each extraction job calls python-extractor which
        // is budgeted at 8 GB / 6 CPU. Whisper large-v3 alone is ~3 GB
        // resident, so >2 concurrent extractions would OOM the VPS.
        // Override via HANGFIRE_WORKERS env var if ressource envelope changes.
        var workerCount = int.TryParse(
            Environment.GetEnvironmentVariable("HANGFIRE_WORKERS"),
            out var parsed) && parsed > 0 ? parsed : 2;
        opts.WorkerCount = workerCount;
    });
}

builder.Services.AddIdentityCore<User>(opts =>
    {
        opts.User.RequireUniqueEmail = true;
        opts.Password.RequireDigit = false;
        opts.Password.RequireLowercase = false;
        opts.Password.RequireUppercase = false;
        opts.Password.RequireNonAlphanumeric = false;
        opts.Password.RequiredLength = 8;
        // REL-0b — per-user brute-force defence. Five wrong-password
        // attempts lock the account for 15 minutes; the counter only
        // decays via successful login (see LoginAsync). Sits alongside
        // the per-IP /api/auth/login SlidingWindowLimiter at the edge:
        // the rate-limit slows a single attacker, the lockout caps the
        // per-account blast radius regardless of source IP.
        opts.Lockout.AllowedForNewUsers = true;
        opts.Lockout.MaxFailedAccessAttempts = 5;
        opts.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
    })
    .AddRoles<IdentityRole<Guid>>()
    .AddEntityFrameworkStores<AppDbContext>()
    .AddDefaultTokenProviders();

builder.Services.AddScoped<IPasswordHasher<User>, Argon2idPasswordHasher>();
builder.Services.AddScoped<TokenService>();
builder.Services.AddScoped<SeedDataService>();

// ── PF3: SMTP email sender (conditional registration) ────────────────
// docker-compose.prod.yml already forwards SMTP_* env vars onto the
// Smtp__* keys. When Host + FromAddress are both populated we wire the
// real SmtpEmailSender; otherwise we fall back to the logger-only
// NoOpEmailSender and emit a startup INFO so operators notice.
builder.Services.Configure<SmtpOptions>(builder.Configuration.GetSection(SmtpOptions.SectionName));
var smtpConfig = builder.Configuration.GetSection(SmtpOptions.SectionName).Get<SmtpOptions>()
                 ?? new SmtpOptions();
if (!string.IsNullOrWhiteSpace(smtpConfig.Host) && !string.IsNullOrWhiteSpace(smtpConfig.FromAddress))
{
    builder.Services.AddSingleton<ISmtpOptionsAccessor, SmtpOptionsAccessor>();
    builder.Services.AddScoped<IEmailSender, SmtpEmailSender>();
}
else
{
    builder.Services.AddScoped<IEmailSender, NoOpEmailSender>();
}
builder.Services.AddScoped<IPrivateCollectionService, PrivateCollectionService>();
builder.Services.AddScoped<IRecipeSearchService, PostgresRecipeSearchService>();
builder.Services.AddScoped<IRecipeRevisionService, RecipeRevisionService>();
builder.Services.AddScoped<PhotoPathMigrationService>();

// ── Photo URL signing (HMAC over path+exp, keyed off Jwt:SigningKey) ──
builder.Services.AddSingleton<ImageSigningService>();
builder.Services.AddSingleton<IPhotoUrlSigner, PhotoUrlSigner>();

// ── Global exception handler: unhandled → uniform 500 + ErrorResponse ──
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();

// ── OpenAPI / Swagger UI (dev-only, gated by env or "OpenApi:Enabled") ──
// In Production the Swagger routes are NOT mounted, so the schema can't
// be scraped by anonymous visitors.
var openApiEnabled = builder.Environment.IsDevelopment()
                     || string.Equals(builder.Configuration["OpenApi:Enabled"], "true",
                         StringComparison.OrdinalIgnoreCase);
if (openApiEnabled)
{
    builder.Services.AddEndpointsApiExplorer();
    builder.Services.AddSwaggerGen(options =>
    {
        options.SwaggerDoc("v1", new Microsoft.OpenApi.Models.OpenApiInfo
        {
            Title = "Familien-Kochbuch API",
            Version = "v1",
            Description = "Private Rezept-Sammlung — Phase 1 API.",
        });
        options.AddSecurityDefinition("Bearer", new Microsoft.OpenApi.Models.OpenApiSecurityScheme
        {
            Type = Microsoft.OpenApi.Models.SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            Description = "JWT Bearer token from POST /api/auth/login",
        });
        options.AddSecurityRequirement(new Microsoft.OpenApi.Models.OpenApiSecurityRequirement
        {
            [new Microsoft.OpenApi.Models.OpenApiSecurityScheme
            {
                Reference = new Microsoft.OpenApi.Models.OpenApiReference
                {
                    Type = Microsoft.OpenApi.Models.ReferenceType.SecurityScheme,
                    Id = "Bearer",
                },
            }] = Array.Empty<string>(),
        });
    });
}

// ── SeaweedFS filer HTTP client + photo storage (plain HTTP, no S3) ──
// The named client is shared by the photo-proxy endpoint and the upload
// path so both sides go through a single HttpClient config point.
builder.Services.AddHttpClient(SeaweedFsPhotoStorage.FilerHttpClientName);
builder.Services.Configure<PhotoStorageOptions>(
    builder.Configuration.GetSection(PhotoStorageOptions.SectionName));
builder.Services.AddScoped<IPhotoStorage, SeaweedFsPhotoStorage>();

// ── P2-5: Python extractor HTTP client + HMAC signer + jobs ──────────
// 150s timeout covers the 120s Python video pipeline budget + overhead.
builder.Services.AddHttpClient(ExtractRecipeFromUrlJob.HttpClientName, (sp, client) =>
{
    var opts = sp.GetRequiredService<IOptions<ExtractorOptions>>().Value;
    client.BaseAddress = new Uri(opts.BaseUrl);
    client.Timeout = TimeSpan.FromSeconds(150);
});
builder.Services.AddSingleton<ExtractorHmacSigner>();
// PV1 — verifies Python's incoming per-import HMAC tokens on the
// /api/internal/imports/{id}/progress callback.
builder.Services.AddSingleton<ImportProgressTokenService>();
builder.Services.AddScoped<PythonExtractorRunner>();
// COVER-0 — separate HttpClient for the post-extract candidate
// thumbnails download. Distinct from the Python extractor client so
// the SSRF / timeout knobs stay independent: each candidate GET is a
// one-shot against an external CDN and gets a tight per-request timeout
// inside CandidateAttacher (5s) rather than the 150s Python budget.
// Auto-redirects are disabled so a malicious CDN can't redirect us
// off the host allowlist mid-flight.
builder.Services.AddHttpClient(CandidateAttacher.HttpClientName)
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        AllowAutoRedirect = false,
    });
// COVER-0 fix — internal docker-hostnames the CandidateAttacher is
// allowed to fetch from directly (skips CDN + public-IP gates). Config
// key ``CandidateAttacher:AllowedInternalHosts`` takes a string[]; the
// compose stack injects the single entry ``python-extractor`` via the
// CANDIDATE_ALLOWED_INTERNAL_HOSTS env var. Falls back to that default
// when the setting is missing so the feature works out of the box.
var allowedInternalHosts = builder.Configuration
    .GetSection("CandidateAttacher:AllowedInternalHosts")
    .Get<string[]>() ?? new[] { "python-extractor" };
builder.Services.AddScoped<CandidateAttacher>(sp => new CandidateAttacher(
    sp.GetRequiredService<AppDbContext>(),
    sp.GetRequiredService<IHttpClientFactory>(),
    sp.GetRequiredService<IPhotoStorage>(),
    sp.GetRequiredService<TimeProvider>(),
    sp.GetRequiredService<ILogger<CandidateAttacher>>(),
    sp.GetRequiredService<IExtractorConfigReader>(),
    resolveHost: null,
    allowedInternalHosts: allowedInternalHosts));
builder.Services.AddScoped<ExtractRecipeFromUrlJob>();
builder.Services.AddScoped<ExtractRecipeFromPhotosJob>();

// ── CR2: Azure OpenAI streaming chat client + title service ──────────
// AzureOpenAI__* config keys bind to AzureOpenAIOptions. ChatDeployment
// falls back to Deployment when blank — a single-deployment resource
// (the current prod shape) gets Just-Works behaviour. The API key is a
// secret and flows through IOptions only; never logged.
builder.Services.Configure<AzureOpenAIOptions>(
    builder.Configuration.GetSection(AzureOpenAIOptions.SectionName));
// 120 s timeout covers the Azure streaming response budget.
builder.Services.AddHttpClient<IAzureOpenAIChatClient, AzureOpenAIChatClient>(
    AzureOpenAIChatClient.HttpClientName,
    client => client.Timeout = TimeSpan.FromSeconds(120));
builder.Services.AddScoped<ChatTitleService>();
// FLAKY-1 — fire-and-forget seam for the chat auto-title Task.Run
// call in ChatEndpoints.TurnAsync. Production no-op; integration
// tests override with a tracking implementation so assertions can
// await background completion deterministically instead of polling
// (which races against the shared in-memory SQLite connection).
builder.Services.AddSingleton<IBackgroundTaskTracker, NullBackgroundTaskTracker>();

// CFG-0 — per-key validator for the admin extractor-config PUT
// endpoint. Stateless; singleton keeps the compiled regex + rule
// tables alive for the process lifetime.
builder.Services.AddSingleton<ConfigKeyValidator>();
// CFG-3 — read-only feature-flag reader over the ExtractorConfig
// table. Scoped so it shares the request's AppDbContext lifetime;
// the two call-sites (CandidateAttacher, ChatEndpoints.TurnAsync)
// issue one PK lookup per user-facing action, so no caching layer.
builder.Services.AddScoped<IExtractorConfigReader, ExtractorConfigReader>();
// PF1 — hourly sweep job that reaps abandoned staged photos (>24h old,
// never promoted onto a recipe). Registered as a recurring job below
// after the Hangfire dashboard is mounted.
builder.Services.AddScoped<SweepAbandonedStagedPhotosJob>();

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

        // P3-8 — SignalR WebSocket upgrade cannot set Authorization
        // headers from a browser, so the client supplies the bearer via
        // the access_token query param on the initial GET /hubs/live.
        // Only trust that shortcut when the request is actually hitting
        // the hub path; the rest of the API must still require the
        // standard header so a leaked query-string token can't widen
        // blast radius beyond the WS upgrade.
        jwtBearer.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;
                if (!string.IsNullOrEmpty(accessToken)
                    && path.StartsWithSegments("/api/hubs/live",
                        StringComparison.OrdinalIgnoreCase))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

// ── P3-8: SignalR + live-sync publisher ───────────────────────────────
// Camel-case JSON names on the wire so the shared TypeScript DTOs in
// packages/shared/src/types/liveSync.ts map 1:1 without
// [JsonPropertyName] on every property.
builder.Services.AddSignalR();
builder.Services.AddSingleton<ILiveSyncPublisher, LiveSyncPublisher>();

// ── CORS (dev): open to local Vite + Caddy ────────────────────────────
const string CorsPolicy = "FamilienKochbuchDev";
builder.Services.AddCors(opts =>
    opts.AddPolicy(CorsPolicy, p => p
        .WithOrigins("http://localhost", "http://localhost:5173")
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials()));

// ── Rate limiting: login = 5/min per IP, generate = 10/min per user ──
// "Login" partitions on client IP because the caller is anonymous — the
// per-user brute-force counterpart lives in the endpoint handler via
// Identity's AccessFailedCount / lockout. Reading the email out of the
// request body for a more granular IP+email partition would require
// buffering the body inside the partition-key factory, which the sync
// RateLimitPartition<string> factory cannot await safely — so we stay
// with IP and rely on account lockout for the per-user limit.
//
// "Generate" partitions on the authenticated user id (sub / NameIdentifier
// claim) because /shopping-list/generate sits behind RequireAuthorization
// → every request has a user. An IP partition would throttle everyone on
// a shared household NAT; a user partition keeps per-human accounting.
// Falls back to IP (then "anonymous") only as a defensive safety net —
// the endpoint itself refuses anonymous traffic.
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // Shared test-env bypass: the TestServer always reports
    // RemoteIpAddress=null + synthetic auth, so rate-limiting would
    // collapse every integration test into one bucket. Tests that
    // specifically want to exercise the limiter (e.g. the dedicated
    // RateLimit tests) simply omit this header.
    static bool ShouldBypassForTests(HttpContext httpContext) =>
        httpContext.RequestServices.GetRequiredService<IHostEnvironment>()
            .IsEnvironment("Testing") &&
        httpContext.Request.Headers["X-Test-Disable-RateLimit"] == "true";

    options.AddPolicy(RateLimitPolicies.Login, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

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

    options.AddPolicy(RateLimitPolicies.Generate, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        var userId = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                     ?? httpContext.User.FindFirst("sub")?.Value
                     ?? httpContext.Connection.RemoteIpAddress?.ToString()
                     ?? "anonymous";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: userId,
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });

    // PV1 — internal Python progress-callback endpoint: per-importId
    // 500/min. One flooding import can't starve concurrent imports'
    // callbacks. The global 10_000/min ceiling is applied separately
    // via options.GlobalLimiter below (see comment there).
    options.AddPolicy(RateLimitPolicies.ImportProgress, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        // Partition on the route's {importId} parameter. Fall back to
        // a shared "unknown" bucket only if the route value is missing —
        // that path shouldn't exist in practice (the route constraint
        // already requires a Guid) but we stay safe by keeping it
        // bounded.
        var importId = httpContext.Request.RouteValues.TryGetValue("importId", out var v)
                       && v is not null
            ? v.ToString() ?? "unknown"
            : "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: importId,
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 500,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });

    // PV1 security — GLOBAL ceiling on /api/internal/* traffic. Runs
    // BEFORE the per-endpoint policy; caps total callback traffic at
    // 10_000/min so an attacker holding a valid HMAC token cannot
    // memory-DoS the server by POSTing with millions of freshly-
    // generated fake GUIDs (the per-importId partitioner would
    // otherwise allocate a brand-new bucket per unique GUID and grow
    // memory unbounded). 10_000/min leaves headroom for ~20 parallel
    // legitimate imports (20× the per-import ceiling). Non-internal
    // routes fall through with NoLimiter so this global pipe doesn't
    // affect unrelated traffic.
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        // Only gate /api/internal/* — everything else is NoLimiter so
        // this global pipe is effectively scoped.
        if (!httpContext.Request.Path.StartsWithSegments(
                InternalOnlyMiddleware.InternalPathPrefix,
                StringComparison.OrdinalIgnoreCase))
        {
            return RateLimitPartition.GetNoLimiter<string>("non-internal");
        }

        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: "internal-global",
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10_000,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });

    // REL-0b — import enqueue endpoints (/api/recipes/import/url +
    // /api/recipes/import/photos). Each import spins up the Python
    // extractor (yt-dlp + Whisper) and at least one Azure OpenAI call
    // — an authenticated attacker (or a runaway-click / stuck reload
    // loop on a legitimate user's device) could otherwise amplify into
    // minutes of CPU + $$$ of Azure cost per request. 5/min per user
    // is generous for hand-driven use and blunts machine-rate abuse.
    // Partitioned on the JWT sub claim so one user's bucket never
    // affects another user. Falls back to IP / "anonymous" only as a
    // defensive safety net; both import endpoints are RequireAuthorization.
    options.AddPolicy(RateLimitPolicies.Import, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        var userId = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                     ?? httpContext.User.FindFirst("sub")?.Value
                     ?? httpContext.Connection.RemoteIpAddress?.ToString()
                     ?? "anonymous";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: userId,
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 5,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });

    // CR2 — chat /turn endpoint. Per-user sliding window, 10/min to
    // match the Generate policy's budget on AI calls. Partitioned on
    // the JWT sub claim so a shared household NAT doesn't throttle
    // everyone into one bucket.
    options.AddPolicy(RateLimitPolicies.ChatTurn, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        var userId = httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
                     ?? httpContext.User.FindFirst("sub")?.Value
                     ?? httpContext.Connection.RemoteIpAddress?.ToString()
                     ?? "anonymous";
        return RateLimitPartition.GetSlidingWindowLimiter(
            partitionKey: userId,
            factory: _ => new SlidingWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                SegmentsPerWindow = 6,
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });

    // P3-8 security — SignalR hub negotiate/connect endpoints.
    // Partitioned per-IP: the hub is [Authorize]d but the negotiate POST
    // still burns CPU on JWT validation before auth rejects, so an
    // anonymous flood would pin a core. 30/min is generous enough for
    // reconnect-storms after a network blip but shuts down trivial
    // DoS from a single source. Fixed window — bursts are expected and
    // we don't want the sliding smoothing to deny legitimate reconnects.
    options.AddPolicy(RateLimitPolicies.Hub, httpContext =>
    {
        if (ShouldBypassForTests(httpContext))
            return RateLimitPartition.GetNoLimiter<string>("test-disabled");

        var ip = httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ip,
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
    });
});

var app = builder.Build();

// PF3 — announce the chosen email sender at boot so operators can spot
// a missing SMTP config in the container logs without digging for it.
if (!string.IsNullOrWhiteSpace(smtpConfig.Host) && !string.IsNullOrWhiteSpace(smtpConfig.FromAddress))
{
    app.Logger.LogInformation(
        "SMTP configured: host={SmtpHost}, port={SmtpPort}, from={SmtpFrom}, startTls={StartTls}",
        smtpConfig.Host, smtpConfig.Port, smtpConfig.FromAddress, smtpConfig.UseStartTls);
}
else
{
    app.Logger.LogInformation(
        "SMTP not configured — using NoOpEmailSender (dev fallback). "
        + "Reset + invite links will appear in the API logs only.");
}

// Honours X-Forwarded-For/Proto from Caddy so downstream code sees the
// real client IP + scheme. DO NOT add KnownNetworks / KnownProxies here
// without re-auditing InternalOnlyMiddleware: the middleware inspects
// Connection.RemoteIpAddress, so a broader forwarded-headers
// configuration could silently change which CIDR the allowlist sees.
// Today the default empty KnownProxies list means the middleware sees
// the raw socket peer (Caddy's docker-bridge IP), which the 172.28.0.0/16
// allowlist covers. Re-run the /api/internal/* reject-path tests
// after any change here.
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
});

app.UseExceptionHandler();
app.UseSerilogRequestLogging();
app.UseCors(CorsPolicy);

// PV1 — defence-in-depth for /api/internal/*. Caddy rejects external
// traffic with 404 before it ever arrives; this middleware is the
// second line of defence for direct-to-Kestrel connections. Registered
// before rate-limiter + auth so an external attacker can't spend our
// limiter budget or invoke a JWT validation on the path they can't
// reach anyway.
app.UseMiddleware<InternalOnlyMiddleware>();

app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapHealthEndpoints();
app.MapMetaEndpoints();
app.MapAuthEndpoints();
app.MapAccountEndpoints();
app.MapInviteEndpoints();
app.MapGroupEndpoints();
app.MapRecipeEndpoints();
app.MapRecipeRevisionEndpoints();
app.MapRatingEndpoints();
app.MapSearchEndpoints();
app.MapPhotoProxyEndpoints();
app.MapImportEndpoints();
app.MapInternalImportProgressEndpoints();
app.MapChatEndpoints();
app.MapAdminAiUsageEndpoints();
app.MapAdminExtractorConfigEndpoints();
app.MapInternalExtractorConfigEndpoints();
app.MapMealPlanEndpoints();
app.MapShoppingListEndpoints();

// P3-8 — SignalR live-sync hub. Requires an authenticated principal
// (the hub itself is [Authorize]d); tokens can arrive via the standard
// Authorization header or — for the WebSocket upgrade only — via the
// access_token query parameter (see JwtBearerEvents.OnMessageReceived).
app.MapHub<LiveSyncHub>("/api/hubs/live").RequireRateLimiting(RateLimitPolicies.Hub);

// ── P2-5: Hangfire dashboard (admin-only, skipped in Testing env) ─
if (!app.Environment.IsEnvironment("Testing"))
{
    app.UseHangfireDashboard("/api/hangfire", new DashboardOptions
    {
        Authorization = new[] { new AdminOnlyAuthorizationFilter() },
        DashboardTitle = "Familien-Kochbuch Jobs",
    });

    // PF1 — register the staged-photo sweep recurring job. Idempotent;
    // re-registers on every boot so a deploy can adjust the schedule
    // without manual intervention.
    RecurringJob.AddOrUpdate<SweepAbandonedStagedPhotosJob>(
        SweepAbandonedStagedPhotosJob.RecurringJobId,
        job => job.ExecuteAsync(CancellationToken.None),
        SweepAbandonedStagedPhotosJob.CronExpression);
}

// ── Swagger UI (dev only) ─────────────────────────────────────────────
if (openApiEnabled)
{
    app.UseSwagger(options =>
    {
        // Serve the OpenAPI document under /api/swagger/{doc}/swagger.json
        // so it sits under the /api prefix proxied by Caddy.
        options.RouteTemplate = "api/swagger/{documentName}/swagger.{extension:regex(^(json|yaml)$)}";
    });
    app.UseSwaggerUI(options =>
    {
        options.RoutePrefix = "api/swagger";
        options.SwaggerEndpoint("/api/swagger/v1/swagger.json", "Familien-Kochbuch API v1");
        options.DocumentTitle = "Familien-Kochbuch API";
    });
}

// ── Migrate + seed on startup (skipped in Testing environment) ────────
if (!app.Environment.IsEnvironment("Testing"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    var seeder = scope.ServiceProvider.GetRequiredService<SeedDataService>();
    await seeder.SeedAsync();

    // Idempotent fixup: rewrite any S3-era photo URLs in Recipes.Photos
    // to the new bare-path format. No-op on fresh installs.
    var photoMigration = scope.ServiceProvider.GetRequiredService<PhotoPathMigrationService>();
    await photoMigration.NormalizePhotoPathsAsync();
}

app.Run();

// Required for WebApplicationFactory<T> in tests.
public partial class Program;

/// <summary>Named rate-limit policies used across auth + meal-plan
/// endpoints.</summary>
internal static class RateLimitPolicies
{
    public const string Login = "login";
    public const string Generate = "generate";
    public const string Hub = "hub";

    /// <summary>PV1 — per-importId 500/min partition guarding
    /// <c>/api/internal/imports/{importId}/progress</c>. Stacked with
    /// a global 10_000/min ceiling applied via
    /// <c>RateLimiterOptions.GlobalLimiter</c> — see Program.cs.</summary>
    public const string ImportProgress = "import-progress";

    /// <summary>CR2 — per-user sliding window 10/min for
    /// <c>POST /api/chat/sessions/{id}/turn</c>. Prevents a single user
    /// from running up Azure costs by spamming turns.</summary>
    public const string ChatTurn = "chat-turn";

    /// <summary>REL-0b — per-user sliding window 5/min for the two
    /// enqueue endpoints <c>POST /api/recipes/import/url</c> and
    /// <c>POST /api/recipes/import/photos</c>. Blunts Azure-cost
    /// amplification through runaway clicks or deliberate abuse.</summary>
    public const string Import = "import";
}

/// <summary>Strongly-typed options for non-auth app config.</summary>
public class AppOptions
{
    public const string SectionName = "App";
    public string FrontendBaseUrl { get; set; } = "http://localhost";
}
