namespace SharedCookbook.Domain.Entities;

/// <summary>
/// LLM-estimated per-portion nutrition values (PRD §5.4, P2-10).
///
/// Immutable value object — all four fields are integers in realistic
/// per-portion ranges. The constructor validates the same bounds the
/// Python post-processor clamps to (kcal 0..5000, macros 0..500 g) so
/// invalid values coming via any path (import, manual PATCH, recipe
/// creation) are rejected at the domain boundary rather than silently
/// stored.
///
/// Persisted as a single JSON column on <see cref="Recipe"/> — see
/// <c>AppDbContext.OnModelCreating</c> for the EF mapping. Postgres
/// stores the column as <c>jsonb</c>; SQLite (test-only) falls back to
/// <c>TEXT</c> per EF Core's provider translation, which gives us the
/// round-trip we need without a value-object mapping per field.
/// </summary>
/// <param name="Kcal">Energie pro Portion — 0..5000.</param>
/// <param name="ProteinG">Eiweiß pro Portion (Gramm) — 0..500.</param>
/// <param name="CarbsG">Kohlenhydrate pro Portion (Gramm) — 0..500.</param>
/// <param name="FatG">Fett pro Portion (Gramm) — 0..500.</param>
public sealed record NutritionEstimate
{
    public const int KcalMin = 0;
    public const int KcalMax = 5000;
    public const int MacroMin = 0;
    public const int MacroMax = 500;

    public NutritionEstimate(int Kcal, int ProteinG, int CarbsG, int FatG)
    {
        if (Kcal < KcalMin || Kcal > KcalMax)
            throw new ArgumentException(
                $"Kcal must be within [{KcalMin}, {KcalMax}], got {Kcal}.", nameof(Kcal));
        if (ProteinG < MacroMin || ProteinG > MacroMax)
            throw new ArgumentException(
                $"ProteinG must be within [{MacroMin}, {MacroMax}], got {ProteinG}.", nameof(ProteinG));
        if (CarbsG < MacroMin || CarbsG > MacroMax)
            throw new ArgumentException(
                $"CarbsG must be within [{MacroMin}, {MacroMax}], got {CarbsG}.", nameof(CarbsG));
        if (FatG < MacroMin || FatG > MacroMax)
            throw new ArgumentException(
                $"FatG must be within [{MacroMin}, {MacroMax}], got {FatG}.", nameof(FatG));

        this.Kcal = Kcal;
        this.ProteinG = ProteinG;
        this.CarbsG = CarbsG;
        this.FatG = FatG;
    }

    public int Kcal { get; init; }
    public int ProteinG { get; init; }
    public int CarbsG { get; init; }
    public int FatG { get; init; }
}
