using FamilienKochbuch.Api.Services;
using FamilienKochbuch.Domain.Enums;
using Xunit;

namespace FamilienKochbuch.Api.Tests.Services;

/// <summary>
/// Tests for the P3-6 <see cref="IngredientCategorizer"/>. Covers the
/// static name→category map, normalisation (lowercase, umlaut-aware
/// fallback via exact match, parenthetical-qualifier stripping,
/// quantity-prefix stripping) and the Sonstiges fallback for unknown
/// ingredients. Each bucket has at least one representative name
/// asserted so a typo in the map will fail a bucket-specific test
/// rather than hide behind the generic Sonstiges fallback.
/// </summary>
public class IngredientCategorizerTests
{
    // ── ObstGemuese ────────────────────────────────────────────────

    [Theory]
    [InlineData("Tomate")]
    [InlineData("Tomaten")]
    [InlineData("Gurke")]
    [InlineData("Zwiebel")]
    [InlineData("Zwiebeln")]
    [InlineData("Knoblauch")]
    [InlineData("Karotte")]
    [InlineData("Möhren")]
    [InlineData("Apfel")]
    [InlineData("Äpfel")]
    [InlineData("Zitrone")]
    [InlineData("Brokkoli")]
    [InlineData("Kartoffeln")]
    [InlineData("Champignons")]
    [InlineData("Ingwer")]
    [InlineData("Paprika")]
    [InlineData("Avocado")]
    public void Categorize_Maps_Common_Obst_Gemuese(string name)
    {
        Assert.Equal(IngredientCategory.ObstGemuese, IngredientCategorizer.Categorize(name));
    }

    // ── Trockenwaren ───────────────────────────────────────────────

    [Theory]
    [InlineData("Mehl")]
    [InlineData("Weizenmehl")]
    [InlineData("Reis")]
    [InlineData("Basmati")]
    [InlineData("Spaghetti")]
    [InlineData("Nudeln")]
    [InlineData("Linsen")]
    [InlineData("Kichererbsen")]
    [InlineData("Zucker")]
    [InlineData("Salz")]
    public void Categorize_Maps_Common_Trockenwaren(string name)
    {
        Assert.Equal(IngredientCategory.Trockenwaren, IngredientCategorizer.Categorize(name));
    }

    // ── Gewuerze ───────────────────────────────────────────────────

    [Theory]
    [InlineData("Pfeffer")]
    [InlineData("Paprikapulver")]
    [InlineData("Chilipulver")]
    [InlineData("Kreuzkümmel")]
    [InlineData("Oregano")]
    [InlineData("Thymian")]
    [InlineData("Currypulver")]
    [InlineData("Vanilleextrakt")]
    [InlineData("Zimt")]
    [InlineData("Muskat")]
    public void Categorize_Maps_Common_Gewuerze(string name)
    {
        Assert.Equal(IngredientCategory.Gewuerze, IngredientCategorizer.Categorize(name));
    }

    // ── Molkerei ───────────────────────────────────────────────────

    [Theory]
    [InlineData("Milch")]
    [InlineData("Joghurt")]
    [InlineData("Butter")]
    [InlineData("Sahne")]
    [InlineData("Parmesan")]
    [InlineData("Mozzarella")]
    [InlineData("Quark")]
    [InlineData("Feta")]
    public void Categorize_Maps_Common_Molkerei(string name)
    {
        Assert.Equal(IngredientCategory.Molkerei, IngredientCategorizer.Categorize(name));
    }

    // ── FleischFisch ───────────────────────────────────────────────

    [Theory]
    [InlineData("Hackfleisch")]
    [InlineData("Rinderhack")]
    [InlineData("Hähnchen")]
    [InlineData("Hähnchenbrust")]
    [InlineData("Lachs")]
    [InlineData("Thunfisch")]
    [InlineData("Speck")]
    [InlineData("Bacon")]
    public void Categorize_Maps_Common_FleischFisch(string name)
    {
        Assert.Equal(IngredientCategory.FleischFisch, IngredientCategorizer.Categorize(name));
    }

    // ── BackenSuess ────────────────────────────────────────────────

    [Theory]
    [InlineData("Backpulver")]
    [InlineData("Hefe")]
    [InlineData("Schokolade")]
    [InlineData("Kakao")]
    [InlineData("Honig")]
    [InlineData("Mandeln")]
    public void Categorize_Maps_Common_BackenSuess(string name)
    {
        Assert.Equal(IngredientCategory.BackenSuess, IngredientCategorizer.Categorize(name));
    }

    // ── KonservenFertig ────────────────────────────────────────────

    [Theory]
    [InlineData("Dosentomaten")]
    [InlineData("Kokosmilch")]
    [InlineData("Tomatenmark")]
    [InlineData("Gemüsebrühe")]
    [InlineData("Ketchup")]
    [InlineData("Senf")]
    [InlineData("Mayonnaise")]
    public void Categorize_Maps_Common_KonservenFertig(string name)
    {
        Assert.Equal(IngredientCategory.KonservenFertig, IngredientCategorizer.Categorize(name));
    }

    // ── GetraenkeOele ──────────────────────────────────────────────

    [Theory]
    [InlineData("Olivenöl")]
    [InlineData("Rapsöl")]
    [InlineData("Sesamöl")]
    [InlineData("Essig")]
    [InlineData("Balsamico")]
    [InlineData("Sojasauce")]
    [InlineData("Weißwein")]
    public void Categorize_Maps_Common_GetraenkeOele(string name)
    {
        Assert.Equal(IngredientCategory.GetraenkeOele, IngredientCategorizer.Categorize(name));
    }

    // ── TiefkuehlBrot ──────────────────────────────────────────────

    [Theory]
    [InlineData("Toastbrot")]
    [InlineData("Baguette")]
    [InlineData("Fladenbrot")]
    [InlineData("Pita")]
    [InlineData("Tortillas")]
    public void Categorize_Maps_Common_TiefkuehlBrot(string name)
    {
        Assert.Equal(IngredientCategory.TiefkuehlBrot, IngredientCategorizer.Categorize(name));
    }

    // ── Normalisation ──────────────────────────────────────────────

    [Theory]
    [InlineData("TOMATE")]
    [InlineData("tomate")]
    [InlineData("Tomate")]
    [InlineData("  Tomate  ")]
    public void Categorize_Is_Case_And_Whitespace_Insensitive(string input)
    {
        Assert.Equal(IngredientCategory.ObstGemuese, IngredientCategorizer.Categorize(input));
    }

    [Fact]
    public void Categorize_Strips_Parenthetical_Qualifier()
    {
        // "Tomate (reif)" → base name "Tomate" → ObstGemuese.
        Assert.Equal(
            IngredientCategory.ObstGemuese,
            IngredientCategorizer.Categorize("Tomate (reif)"));
    }

    [Fact]
    public void Categorize_Strips_Bracketed_Qualifier_With_Extra_Whitespace()
    {
        Assert.Equal(
            IngredientCategory.ObstGemuese,
            IngredientCategorizer.Categorize("Tomate   (vom Markt)"));
    }

    [Fact]
    public void Categorize_Strips_Leading_Quantity_Prefix()
    {
        // Accidental paste "200g Mehl" still categorises as Trockenwaren.
        Assert.Equal(
            IngredientCategory.Trockenwaren,
            IngredientCategorizer.Categorize("200g Mehl"));
    }

    [Fact]
    public void Categorize_Strips_Leading_Quantity_With_Space()
    {
        Assert.Equal(
            IngredientCategory.Trockenwaren,
            IngredientCategorizer.Categorize("500 g Mehl"));
    }

    [Fact]
    public void Categorize_Matches_Multi_Word_Name_By_First_Word()
    {
        // "Frische Tomate" — fall through to token-based match on "Tomate".
        Assert.Equal(
            IngredientCategory.ObstGemuese,
            IngredientCategorizer.Categorize("Frische Tomate"));
    }

    [Fact]
    public void Categorize_Matches_Longer_Qualified_Entry_Exactly()
    {
        // "Griechischer Joghurt" is an exact map entry → Molkerei.
        Assert.Equal(
            IngredientCategory.Molkerei,
            IngredientCategorizer.Categorize("Griechischer Joghurt"));
    }

    // ── Fallback ───────────────────────────────────────────────────

    [Fact]
    public void Categorize_Unknown_Returns_Sonstiges()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("Zzxxqq-Fantasiezutat"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void Categorize_Empty_Or_Null_Returns_Sonstiges(string? input)
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize(input!));
    }

    [Fact]
    public void Categorize_Umlaut_Variants_Map_Consistently()
    {
        // Both the umlaut-bearing form and the ae-form should land in
        // the same bucket so a recipe author's keyboard shortcut does
        // not change the supermarket aisle.
        Assert.Equal(
            IngredientCategorizer.Categorize("Möhren"),
            IngredientCategorizer.Categorize("Moehren"));
    }

    // ── Fallback cascade (first-token + contains-on-tokens) ────────

    [Fact]
    public void Categorize_First_Token_Prefix_Matches_When_Adjective_Leads()
    {
        // "bio" is not in the map; contains-on-tokens picks up
        // "tomaten" → ObstGemuese. Covers the cascade step that kicks
        // in after the first-token lookup misses.
        Assert.Equal(
            IngredientCategory.ObstGemuese,
            IngredientCategorizer.Categorize("bio Tomaten"));
    }

    [Fact]
    public void Categorize_Contains_On_Tokens_Matches_Mid_Phrase()
    {
        // None of "frische", "mediterrane", "gemahlen" is a map key,
        // but "oregano" is → Gewuerze. Verifies the cascade reaches
        // the later tokens when the earlier ones miss.
        Assert.Equal(
            IngredientCategory.Gewuerze,
            IngredientCategorizer.Categorize("frische mediterrane Oregano gemahlen"));
    }

    [Fact]
    public void Categorize_All_Tokens_Miss_Returns_Sonstiges()
    {
        // "pulled", "pork", "burger" — none are in the map → cascade
        // exhausts → Sonstiges.
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("pulled pork burger"));
    }

    // ── Adversarial Unicode (P3-6 security hardening) ─────────────
    //
    // Before the P3-6 fix, input.Normalize(FormC) on malformed UTF-16
    // threw ArgumentException and bubbled up as a 500 on
    // /shopping-list/generate. The call was a no-op for the
    // diacritics-preserved map and has been removed; these adversarial
    // inputs must now simply return Sonstiges without throwing.
    //
    // Each case lives in its own [Fact] to avoid xUnit InlineData
    // display-name collisions on malformed-UTF-16 surrogates.

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Adversarial_Unicode_Without_Throwing_LoneHighSurrogate()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("\uD800"));
    }

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Adversarial_Unicode_Without_Throwing_LoneLowSurrogate()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("\uDFFF"));
    }

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Adversarial_Unicode_Without_Throwing_NullChar()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("\0"));
    }

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Adversarial_Unicode_Without_Throwing_EmbeddedNull()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("abc\0def"));
    }

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Adversarial_Unicode_Without_Throwing_EmbeddedLoneSurrogate()
    {
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize("foo\uD800bar"));
    }

    [Fact]
    public void Categorize_Returns_Sonstiges_For_Max_Length_Unknown_Without_Throwing()
    {
        // 200-char boundary: the regex + whitespace-collapse loop must
        // run in bounded time even on a long unknown string.
        var input = new string('a', 200);
        Assert.Equal(
            IngredientCategory.Sonstiges,
            IngredientCategorizer.Categorize(input));
    }
}
