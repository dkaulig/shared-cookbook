using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SharedCookbook.Api.Tests.Infrastructure;

/// <summary>
/// Shared JSON options + read helpers for integration tests. Mirrors the
/// production wire format set up by <c>ConfigureHttpJsonOptions</c> in
/// <c>Program.cs</c> — most importantly the <see cref="JsonStringEnumConverter"/>
/// so the test client deserialises enum-valued DTO fields exactly like a
/// real TypeScript client. Without this, the default
/// <see cref="JsonSerializerOptions.Default"/> falls back to integer enum
/// reading and tests that <c>ReadFromJsonAsync</c> a DTO with a
/// <c>MealSlot</c> / <c>LiveSyncAction</c> field throw on the
/// <c>"Mittag"</c> / <c>"Created"</c> string the server now emits.
/// </summary>
public static class TestJsonExtensions
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerOptions.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    public static Task<T?> ReadDtoAsync<T>(
        this HttpContent content,
        CancellationToken ct = default)
        => content.ReadFromJsonAsync<T>(Options, ct);
}
