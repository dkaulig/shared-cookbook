using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Entities;
using FamilienKochbuch.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// CFG-3 — unit tests for <see cref="ExtractorConfigReader"/>. The
/// reader is the thin EF-projection-with-JSON-parse used by
/// <see cref="CandidateAttacher"/> + <c>ChatEndpoints.TurnAsync</c>
/// to consult feature-flag rows. The tests exercise every branch of
/// the parse + fallback logic directly against an in-memory SQLite DB
/// so the caller-visible contract stays explicit.
/// </summary>
public class ExtractorConfigReaderTests : IAsyncLifetime
{
    private SqliteConnection _connection = null!;
    private AppDbContext _db = null!;
    private ExtractorConfigReader _reader = null!;

    public async Task InitializeAsync()
    {
        _connection = new SqliteConnection("DataSource=:memory:");
        await _connection.OpenAsync();
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlite(_connection).Options;
        _db = new AppDbContext(options);
        await _db.Database.EnsureCreatedAsync();
        _reader = new ExtractorConfigReader(
            _db, NullLogger<ExtractorConfigReader>.Instance);
    }

    public async Task DisposeAsync()
    {
        await _db.DisposeAsync();
        await _connection.DisposeAsync();
    }

    private async Task SeedAsync(string key, string valueJson)
    {
        _db.ExtractorConfigs.Add(new ExtractorConfig(
            key, valueJson, ExtractorConfigValueType.Bool,
            DateTimeOffset.UtcNow));
        await _db.SaveChangesAsync();
    }

    [Fact]
    public async Task Returns_True_When_Row_Value_Is_Json_True()
    {
        await SeedAsync("feature.chat_enabled", "true");

        var result = await _reader.GetFeatureFlagAsync(
            "feature.chat_enabled", defaultValue: false, CancellationToken.None);

        Assert.True(result);
    }

    [Fact]
    public async Task Returns_False_When_Row_Value_Is_Json_False()
    {
        await SeedAsync("feature.chat_enabled", "false");

        var result = await _reader.GetFeatureFlagAsync(
            "feature.chat_enabled", defaultValue: true, CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async Task Falls_Back_To_Default_When_Row_Is_Missing()
    {
        // Nothing seeded — row-missing → fallback.
        var trueDefault = await _reader.GetFeatureFlagAsync(
            "feature.missing", defaultValue: true, CancellationToken.None);
        var falseDefault = await _reader.GetFeatureFlagAsync(
            "feature.missing", defaultValue: false, CancellationToken.None);

        Assert.True(trueDefault);
        Assert.False(falseDefault);
    }

    [Fact]
    public async Task Falls_Back_To_Default_When_Value_Is_Malformed_Json()
    {
        // Payload that isn't parseable as JSON at all.
        await SeedAsync("feature.chat_enabled", "\"not-a-bool");

        var result = await _reader.GetFeatureFlagAsync(
            "feature.chat_enabled", defaultValue: true, CancellationToken.None);

        Assert.True(result);
    }

    [Fact]
    public async Task Falls_Back_To_Default_When_Value_Is_Json_String_Not_Bool()
    {
        // Parses as JSON but isn't a boolean literal.
        await SeedAsync("feature.chat_enabled", "\"yes\"");

        var result = await _reader.GetFeatureFlagAsync(
            "feature.chat_enabled", defaultValue: false, CancellationToken.None);

        Assert.False(result);
    }

    [Fact]
    public async Task Falls_Back_To_Default_When_Value_Is_Json_Number()
    {
        await SeedAsync("feature.chat_enabled", "1");

        var result = await _reader.GetFeatureFlagAsync(
            "feature.chat_enabled", defaultValue: true, CancellationToken.None);

        Assert.True(result);
    }

    [Fact]
    public async Task Blank_Key_Throws()
    {
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _reader.GetFeatureFlagAsync(
                "", defaultValue: true, CancellationToken.None));
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _reader.GetFeatureFlagAsync(
                "   ", defaultValue: true, CancellationToken.None));
    }
}
