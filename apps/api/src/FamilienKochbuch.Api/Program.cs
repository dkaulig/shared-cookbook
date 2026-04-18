using FamilienKochbuch.Api.Endpoints;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Serilog — structured JSON logs to console (all environments)
builder.Host.UseSerilog((ctx, services, cfg) => cfg
    .ReadFrom.Configuration(ctx.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console());

var app = builder.Build();

app.MapHealthEndpoints();

app.Run();

// Required for WebApplicationFactory<T> in tests.
public partial class Program;
