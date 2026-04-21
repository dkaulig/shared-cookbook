using FamilienKochbuch.Domain.Entities;
using Xunit;

namespace FamilienKochbuch.Domain.Tests.Entities;

/// <summary>
/// CFG-0 — invariants for the <see cref="ExtractorConfig"/> entity.
/// Covers Key length bounds, ValueType enum guard, Version monotonicity,
/// UpdateValue's returned "old value" payload, and the UpdatedBy
/// empty-Guid rejection (system seeds use <c>null</c>, never
/// <see cref="Guid.Empty"/>).
/// </summary>
public class ExtractorConfigTests
{
    private static ExtractorConfig NewConfig(
        string key = "llm.structured.temperature",
        string valueJson = "0",
        ExtractorConfigValueType valueType = ExtractorConfigValueType.Float,
        DateTimeOffset? updatedAt = null,
        Guid? updatedBy = null) =>
        new(
            key: key,
            valueJson: valueJson,
            valueType: valueType,
            updatedAt: updatedAt ?? DateTimeOffset.UtcNow,
            updatedBy: updatedBy);

    [Fact]
    public void Constructor_Sets_All_Fields_And_Starts_At_Version_Zero()
    {
        var when = DateTimeOffset.UtcNow;
        var cfg = new ExtractorConfig(
            key: "llm.structured.max_completion_tokens",
            valueJson: "2048",
            valueType: ExtractorConfigValueType.Int,
            updatedAt: when,
            updatedBy: null);

        Assert.Equal("llm.structured.max_completion_tokens", cfg.Key);
        Assert.Equal("2048", cfg.ValueJson);
        Assert.Equal(ExtractorConfigValueType.Int, cfg.ValueType);
        Assert.Equal(when, cfg.UpdatedAt);
        Assert.Null(cfg.UpdatedBy);
        Assert.Equal(0, cfg.Version);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Constructor_Rejects_Blank_Key(string key)
    {
        Assert.Throws<ArgumentException>(() => NewConfig(key: key));
    }

    [Fact]
    public void Constructor_Rejects_Overlong_Key()
    {
        var longKey = new string('x', ExtractorConfig.KeyMaxLength + 1);
        Assert.Throws<ArgumentException>(() => NewConfig(key: longKey));
    }

    [Fact]
    public void Constructor_Accepts_Key_At_Max_Length()
    {
        var justRight = new string('x', ExtractorConfig.KeyMaxLength);
        var cfg = NewConfig(key: justRight);
        Assert.Equal(justRight, cfg.Key);
    }

    [Fact]
    public void Constructor_Trims_Key_Whitespace()
    {
        var cfg = NewConfig(key: "  feature.chat_enabled  ");
        Assert.Equal("feature.chat_enabled", cfg.Key);
    }

    [Fact]
    public void Constructor_Rejects_Blank_ValueJson()
    {
        Assert.Throws<ArgumentException>(() => NewConfig(valueJson: ""));
        Assert.Throws<ArgumentException>(() => NewConfig(valueJson: "   "));
    }

    [Fact]
    public void Constructor_Rejects_Unknown_ValueType()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            NewConfig(valueType: (ExtractorConfigValueType)999));
    }

    [Fact]
    public void Constructor_Rejects_Empty_UpdatedBy_Guid()
    {
        Assert.Throws<ArgumentException>(() => NewConfig(updatedBy: Guid.Empty));
    }

    [Fact]
    public void Constructor_Accepts_Null_UpdatedBy_For_Seeds()
    {
        var cfg = NewConfig(updatedBy: null);
        Assert.Null(cfg.UpdatedBy);
    }

    [Fact]
    public void UpdateValue_Bumps_Version_And_Stamps_Fields()
    {
        var cfg = NewConfig(valueJson: "0");
        var actor = Guid.NewGuid();
        var when = DateTimeOffset.UtcNow.AddMinutes(5);

        var previous = cfg.UpdateValue("0.5", when, actor);

        Assert.Equal("0", previous);
        Assert.Equal("0.5", cfg.ValueJson);
        Assert.Equal(1, cfg.Version);
        Assert.Equal(when, cfg.UpdatedAt);
        Assert.Equal(actor, cfg.UpdatedBy);
    }

    [Fact]
    public void UpdateValue_Monotonically_Increments_Version()
    {
        var cfg = NewConfig(valueJson: "0");
        var actor = Guid.NewGuid();

        cfg.UpdateValue("0.2", DateTimeOffset.UtcNow, actor);
        cfg.UpdateValue("0.4", DateTimeOffset.UtcNow, actor);
        cfg.UpdateValue("0.6", DateTimeOffset.UtcNow, actor);

        Assert.Equal(3, cfg.Version);
        Assert.Equal("0.6", cfg.ValueJson);
    }

    [Fact]
    public void UpdateValue_Rejects_Blank_NewValueJson()
    {
        var cfg = NewConfig();
        Assert.Throws<ArgumentException>(() =>
            cfg.UpdateValue("", DateTimeOffset.UtcNow, Guid.NewGuid()));
    }

    [Fact]
    public void UpdateValue_Rejects_Empty_UpdatedBy_Guid()
    {
        var cfg = NewConfig();
        Assert.Throws<ArgumentException>(() =>
            cfg.UpdateValue("\"x\"", DateTimeOffset.UtcNow, Guid.Empty));
    }
}

/// <summary>
/// CFG-0 — invariants for the <see cref="ExtractorConfigHistory"/>
/// audit entity.
/// </summary>
public class ExtractorConfigHistoryTests
{
    [Fact]
    public void Constructor_Sets_All_Fields()
    {
        var when = DateTimeOffset.UtcNow;
        var actor = Guid.NewGuid();
        var h = new ExtractorConfigHistory(
            key: "llm.structured.temperature",
            oldValueJson: "0",
            newValueJson: "0.5",
            changedAt: when,
            changedBy: actor);

        Assert.NotEqual(Guid.Empty, h.Id);
        Assert.Equal("llm.structured.temperature", h.Key);
        Assert.Equal("0", h.OldValueJson);
        Assert.Equal("0.5", h.NewValueJson);
        Assert.Equal(when, h.ChangedAt);
        Assert.Equal(actor, h.ChangedBy);
    }

    [Fact]
    public void Constructor_Accepts_Null_ChangedBy_For_System_Edits()
    {
        var h = new ExtractorConfigHistory(
            key: "llm.structured.temperature",
            oldValueJson: "0",
            newValueJson: "0.5",
            changedAt: DateTimeOffset.UtcNow,
            changedBy: null);

        Assert.Null(h.ChangedBy);
    }

    [Fact]
    public void Constructor_Rejects_Empty_ChangedBy()
    {
        Assert.Throws<ArgumentException>(() => new ExtractorConfigHistory(
            key: "llm.structured.temperature",
            oldValueJson: "0",
            newValueJson: "0.5",
            changedAt: DateTimeOffset.UtcNow,
            changedBy: Guid.Empty));
    }

    [Fact]
    public void Constructor_Rejects_Blank_Key()
    {
        Assert.Throws<ArgumentException>(() => new ExtractorConfigHistory(
            key: "",
            oldValueJson: "0",
            newValueJson: "0.5",
            changedAt: DateTimeOffset.UtcNow,
            changedBy: null));
    }

    [Fact]
    public void Constructor_Rejects_Blank_NewValueJson()
    {
        Assert.Throws<ArgumentException>(() => new ExtractorConfigHistory(
            key: "llm.x",
            oldValueJson: "0",
            newValueJson: "",
            changedAt: DateTimeOffset.UtcNow,
            changedBy: null));
    }
}
