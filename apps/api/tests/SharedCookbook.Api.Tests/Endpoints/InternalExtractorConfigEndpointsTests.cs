using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using SharedCookbook.Api.Endpoints;
using SharedCookbook.Api.Services;
using SharedCookbook.Api.Tests.Infrastructure;
using SharedCookbook.Domain.Entities;
using SharedCookbook.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace SharedCookbook.Api.Tests.Endpoints;

/// <summary>
/// CFG-0 — integration tests for the Python-facing internal surface.
/// Exercises the docker-internal trust-boundary gate via
/// <see cref="InternalOnlyMiddleware.TestBypassHeader"/>, verifies the
/// seeded registry is fully exposed over the internal route, and
/// exercises the no-op refresh stub the E2E gate relies on.
///
/// External reject is covered by the dedicated
/// <see cref="Services.InternalOnlyMiddlewareTests"/> suite; here we
/// focus on the endpoint's business surface once the middleware has
/// passed us through.
/// </summary>
public class InternalExtractorConfigEndpointsTests
    : IClassFixture<SharedCookbookWebApplicationFactory>, IAsyncLifetime
{
    private readonly SharedCookbookWebApplicationFactory _factory;
    private HttpClient _client = null!;

    public InternalExtractorConfigEndpointsTests(SharedCookbookWebApplicationFactory factory)
    {
        _factory = factory;
    }

    public async Task InitializeAsync()
    {
        _client = _factory.CreateRateLimitBypassingClient();
        _client.DefaultRequestHeaders.Add(InternalOnlyMiddleware.TestBypassHeader, "true");
        await ResetAsync();
    }

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    private async Task ResetAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.ExtractorConfigHistories.RemoveRange(db.ExtractorConfigHistories);
        await db.SaveChangesAsync();

        var existing = await db.ExtractorConfigs.ToListAsync();
        db.ExtractorConfigs.RemoveRange(existing);
        await db.SaveChangesAsync();
        var now = DateTimeOffset.UtcNow;
        foreach (var entry in ExtractorConfigDefaults.All)
        {
            db.ExtractorConfigs.Add(new ExtractorConfig(
                key: entry.Key,
                valueJson: entry.DefaultValueJson,
                valueType: entry.ValueType,
                updatedAt: now,
                updatedBy: null));
        }
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Internal_List_Returns_All_Seeded_Keys()
    {
        var res = await _client.GetAsync("/api/internal/extractor-config/");
        res.EnsureSuccessStatusCode();

        var body = await res.Content.ReadFromJsonAsync<InternalExtractorConfigEndpoints.InternalConfigListResponse>();
        Assert.NotNull(body);
        Assert.Equal(ExtractorConfigDefaults.All.Count, body!.Items.Length);
        var keys = body.Items.Select(i => i.Key).ToHashSet();
        foreach (var entry in ExtractorConfigDefaults.All)
        {
            Assert.Contains(entry.Key, keys);
        }
    }

    [Fact]
    public async Task Internal_List_Unauthenticated_Request_Succeeds_When_Internal()
    {
        // No Authorization header is required — the internal route lives
        // on the docker-internal trust boundary.
        var res = await _client.GetAsync("/api/internal/extractor-config/");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Internal_Refresh_Returns_204()
    {
        var res = await _client.PostAsync("/api/internal/extractor-config/refresh", null);
        Assert.Equal(HttpStatusCode.NoContent, res.StatusCode);
    }

    [Fact]
    public async Task Internal_List_External_Origin_Is_Rejected_By_Middleware()
    {
        using var externalClient = _factory.CreateRateLimitBypassingClient();
        // Deliberately omit the test-bypass header — TestServer sets
        // RemoteIpAddress=null so InternalOnlyMiddleware rejects with
        // 404 (same behaviour as an external caller).
        var res = await externalClient.GetAsync("/api/internal/extractor-config/");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    // ── seed-prompts endpoint ─────────────────────────────────────────
    //
    // CFG-1b — `POST /api/internal/extractor-config/seed-prompts` is the
    // internal hook the python-extractor calls at startup so the three
    // `*.system_prompt` placeholder rows get the real prompt strings the
    // first time they're observed. Same trust boundary as the GET — the
    // InternalOnlyMiddleware gates the route.

    private const string SeedPromptsPath = "/api/internal/extractor-config/seed-prompts";

    private async Task<string> GetValueJsonAsync(string key)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs.SingleAsync(c => c.Key == key);
        return row.ValueJson;
    }

    private async Task<int> GetVersionAsync(string key)
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var row = await db.ExtractorConfigs.SingleAsync(c => c.Key == key);
        return row.Version;
    }

    [Fact]
    public async Task SeedPrompts_Writes_Placeholder_Rows()
    {
        // Arrange — defaults seeded at fixture init carry the literal
        // "PLACEHOLDER_*_PROMPT" JSON strings on all three system-prompt
        // keys. Verify before posting so the test pins the precondition.
        Assert.StartsWith(
            "\"PLACEHOLDER_",
            await GetValueJsonAsync("llm.structured.system_prompt"),
            StringComparison.Ordinal);

        // Real DE prompts run to several KB; the seed endpoint enforces
        // a 100-char floor (mirrors ConfigKeyValidator.MinPromptChars)
        // so a blank seed can't masquerade as a "real" prompt. Pad the
        // test fixtures past that floor.
        const string structuredPrompt =
            "Du bist ein hilfreicher Koch-Assistent für strukturierte Extraktion. "
            + "Extrahiere präzise Zutaten, Mengen und Zubereitungsschritte aus dem Quelltext.";
        const string chatPrompt =
            "Du bist ein hilfreicher Koch-Assistent. Halte dich kurz und stelle "
            + "präzise Rückfragen zu Zutaten, Portionen oder Zubereitungszeit, falls nötig.";
        const string visionPrompt =
            "Analysiere das Foto und extrahiere ein strukturiertes Rezept. "
            + "Erkenne deutsche Handschrift, behalte alte Maßeinheiten unverändert bei.";
        var body = new
        {
            structured = structuredPrompt,
            chat = chatPrompt,
            vision = visionPrompt,
        };

        // Act
        var res = await _client.PostAsJsonAsync(SeedPromptsPath, body);

        // Assert — 200 OK, every key reports "written".
        res.EnsureSuccessStatusCode();
        var summary = await res.Content
            .ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.NotNull(summary);
        Assert.Equal("written", summary!["structured"]);
        Assert.Equal("written", summary["chat"]);
        Assert.Equal("written", summary["vision"]);

        // DB rows now carry the new prompts. Compare via JSON round-trip
        // so the assertion is agnostic to umlaut-escape policy
        // (System.Text.Json defaults to `ü` for ü, the shape every
        // existing admin PUT also produces).
        Assert.Equal(
            structuredPrompt,
            JsonSerializer.Deserialize<string>(
                await GetValueJsonAsync("llm.structured.system_prompt")));
        Assert.Equal(
            chatPrompt,
            JsonSerializer.Deserialize<string>(
                await GetValueJsonAsync("llm.chat_to_recipe.system_prompt")));
        Assert.Equal(
            visionPrompt,
            JsonSerializer.Deserialize<string>(
                await GetValueJsonAsync("llm.vision.system_prompt")));
    }

    [Fact]
    public async Task SeedPrompts_Skips_Admin_Edited_Rows()
    {
        // Arrange — pretend an admin already edited the structured row
        // via the admin UI. The seed endpoint must NOT clobber that.
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var row = await db.ExtractorConfigs
                .SingleAsync(c => c.Key == "llm.structured.system_prompt");
            row.UpdateValue(
                newValueJson: "\"Admin hat das schon geändert.\"",
                updatedAt: DateTimeOffset.UtcNow,
                updatedBy: null);
            await db.SaveChangesAsync();
        }
        var versionBefore = await GetVersionAsync("llm.structured.system_prompt");

        var body = new
        {
            structured =
                "Sollte nicht geschrieben werden, weil der Admin diese Zeile schon "
                + "geändert hat. Das ist eine Schutzbedingung — Idempotenz wahrt Edits.",
            chat =
                "Du bist ein hilfreicher Koch-Assistent. Halte dich kurz und stelle "
                + "präzise Rückfragen zu Zutaten, Portionen oder Zubereitungszeit.",
            vision =
                "Analysiere das Foto und extrahiere ein strukturiertes Rezept. "
                + "Erkenne deutsche Handschrift, behalte alte Maßeinheiten unverändert bei.",
        };

        // Act
        var res = await _client.PostAsJsonAsync(SeedPromptsPath, body);

        // Assert — 200 OK; structured "skipped", chat + vision "written".
        res.EnsureSuccessStatusCode();
        var summary = await res.Content
            .ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.NotNull(summary);
        Assert.Equal("skipped", summary!["structured"]);
        Assert.Equal("written", summary["chat"]);
        Assert.Equal("written", summary["vision"]);

        // Admin-edited row stays untouched, version unchanged.
        Assert.Equal(
            "\"Admin hat das schon geändert.\"",
            await GetValueJsonAsync("llm.structured.system_prompt"));
        Assert.Equal(
            versionBefore,
            await GetVersionAsync("llm.structured.system_prompt"));
    }

    [Fact]
    public async Task SeedPrompts_Bumps_Version_On_Overwrite()
    {
        // Defaults seed Version=0 for every row.
        Assert.Equal(0, await GetVersionAsync("llm.structured.system_prompt"));

        var body = new
        {
            structured =
                "Strukturierter Prompt — Du bist ein hilfreicher Koch-Assistent für "
                + "strukturierte Extraktion aus Video- und Blog-Quellen.",
            chat =
                "Chat-Prompt — Du bist ein hilfreicher Koch-Assistent. Halte dich "
                + "kurz und stelle präzise Rückfragen zu Zutaten oder Portionen.",
            vision =
                "Vision-Prompt — Analysiere das Foto und extrahiere ein strukturiertes "
                + "Rezept. Erkenne deutsche Handschrift, behalte alte Maßeinheiten bei.",
        };
        var res = await _client.PostAsJsonAsync(SeedPromptsPath, body);
        res.EnsureSuccessStatusCode();

        Assert.Equal(1, await GetVersionAsync("llm.structured.system_prompt"));
        Assert.Equal(1, await GetVersionAsync("llm.chat_to_recipe.system_prompt"));
        Assert.Equal(1, await GetVersionAsync("llm.vision.system_prompt"));
    }

    [Fact]
    public async Task SeedPrompts_External_Origin_Is_Rejected_By_Middleware()
    {
        // No test-bypass header → InternalOnlyMiddleware rejects 404,
        // identical contract to the GET. Confirms the new route is
        // gated by the same trust boundary, not accidentally public.
        using var externalClient = _factory.CreateRateLimitBypassingClient();
        var body = new { structured = "x", chat = "y", vision = "z" };
        var res = await externalClient.PostAsJsonAsync(SeedPromptsPath, body);
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task SeedPrompts_Rejects_Blank_Prompt()
    {
        // A blank / whitespace payload would otherwise replace the
        // PLACEHOLDER row with "" and the admin UI would render an
        // empty textarea — same regression class as the original bug.
        // The endpoint must enforce a minimum length floor.
        var body = new
        {
            structured = "   ",
            chat = "Du bist ein hilfreicher Koch-Assistent. " // also too short
                + "Stelle präzise Rückfragen.",
            vision = "Analysiere das Foto und extrahiere ein strukturiertes Rezept. "
                + "Erkenne deutsche Handschrift, behalte alte Maßeinheiten bei.",
        };
        var res = await _client.PostAsJsonAsync(SeedPromptsPath, body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        // Database untouched — placeholder stays in the structured row.
        Assert.StartsWith(
            "\"PLACEHOLDER_",
            await GetValueJsonAsync("llm.structured.system_prompt"),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task SeedPrompts_Rejects_Oversized_Prompt()
    {
        // Defence: an attacker who somehow reaches the internal route
        // (compromised dev cluster, misconfigured deploy) shouldn't be
        // able to inflate one row to multi-MB. Cap each prompt at 16 KB
        // and 400 anything bigger so admins notice.
        var oversized = new string('x', 16 * 1024 + 1);
        var body = new { structured = oversized, chat = "ok", vision = "ok" };
        var res = await _client.PostAsJsonAsync(SeedPromptsPath, body);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        // Database untouched — the placeholder is still in the
        // structured row.
        Assert.StartsWith(
            "\"PLACEHOLDER_",
            await GetValueJsonAsync("llm.structured.system_prompt"),
            StringComparison.Ordinal);
    }
}
