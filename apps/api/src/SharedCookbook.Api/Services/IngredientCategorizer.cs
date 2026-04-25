using System.Text.RegularExpressions;
using SharedCookbook.Domain.Enums;

namespace SharedCookbook.Api.Services;

/// <summary>
/// P3-6 static categorizer: maps a raw ingredient name (as stored on a
/// <c>Recipe.Ingredient</c>) into a supermarket-aisle
/// <see cref="IngredientCategory"/>.
///
/// Strategy (per plan §P3-6 + decision #5):
/// <list type="number">
///   <item>Normalise the input: trim, lower-case (invariant), strip a
///     leading "200g" / "1 kg" quantity prefix the user might have
///     pasted into the name field, strip parenthetical qualifiers
///     like "(reif)" or "[bio]".</item>
///   <item>Look the normalised string up in the static map (exact
///     match). The map contains the most frequent German household
///     ingredients; umlauts + common spelling variants (e.g.
///     "Möhren" / "Moehren", "Tomate" / "Tomaten") are included as
///     separate keys so we do not need a fuzzy matcher.</item>
///   <item>Fallback cascade: first-token prefix match (exact lookup of
///     <c>tokens[0]</c> in the map), then contains-on-tokens (exact
///     lookup of each remaining token in the map, first hit wins).
///     Still nothing → return <see cref="IngredientCategory.Sonstiges"/>.
///     The user can trigger an on-demand LLM recategorize from the
///     UI (P3-6.5).</item>
/// </list>
///
/// Thread-safety: the map is built once in the static ctor and is
/// read-only thereafter, so the type is safe for concurrent callers.
///
/// Map coverage (~190 entries) intentionally aims for breadth over
/// depth — it will miss exotic ingredients (Yuzu, Nduja, Harissa), but
/// it covers &gt; 80 % of the staples a German home cook writes into
/// the shopping list.
/// </summary>
public static class IngredientCategorizer
{
    /// <summary>
    /// Regex that strips a leading quantity + unit prefix from a
    /// pasted ingredient name. Matches "200g", "500 g", "1kg",
    /// "2 Stück" — anything that begins with digits, optional
    /// decimal, optional whitespace, optional alphabetic unit, then a
    /// space separating it from the real ingredient name.
    /// </summary>
    private static readonly Regex QuantityPrefix = new(
        @"^\s*\d+([.,]\d+)?\s*[a-zA-ZäöüÄÖÜß]*\s+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Regex that strips trailing parenthetical / bracketed qualifiers
    /// like "(reif)", "[bio]", "(vom Markt)".
    /// </summary>
    private static readonly Regex BracketedQualifier = new(
        @"\s*[\(\[][^)\]]*[\)\]]\s*",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly IReadOnlyDictionary<string, IngredientCategory> Map = BuildMap();

    /// <summary>
    /// Returns the supermarket aisle bucket for <paramref name="ingredientName"/>.
    /// Null / empty / whitespace / unknown → <see cref="IngredientCategory.Sonstiges"/>.
    /// </summary>
    public static IngredientCategory Categorize(string ingredientName)
    {
        if (string.IsNullOrWhiteSpace(ingredientName))
            return IngredientCategory.Sonstiges;

        var normalised = Normalise(ingredientName);
        if (normalised.Length == 0)
            return IngredientCategory.Sonstiges;

        // 1. Exact match on the full normalised string — covers
        //    "griechischer joghurt", "geräuchertes paprikapulver", etc.
        if (Map.TryGetValue(normalised, out var cat))
            return cat;

        // 2. First-token prefix match: split on whitespace and look up
        //    tokens[0] exactly in the map. This biases toward the
        //    "main" noun when users prefix adjectives like "bio" or
        //    "frische" (e.g. "bio Tomaten" → "bio" misses, falls
        //    through to step 3 which then catches "tomaten").
        var tokens = normalised.Split(
            ' ',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        if (tokens.Length > 0 && Map.TryGetValue(tokens[0], out cat))
            return cat;

        // 3. Contains-on-tokens: iterate the remaining tokens and look
        //    each up in the map. O(tokens) × O(1) hash lookup is
        //    cheaper than scanning the ~190-entry map for each token.
        //    First hit wins, so "frische mediterrane Basilikum Blätter"
        //    returns Gewuerze via "basilikum".
        for (var i = 1; i < tokens.Length; i++)
        {
            if (Map.TryGetValue(tokens[i], out cat))
                return cat;
        }

        // 4. Nothing matched → Sonstiges.
        return IngredientCategory.Sonstiges;
    }

    /// <summary>
    /// Lower-cases, trims, strips a leading quantity, strips bracketed
    /// qualifiers, collapses whitespace. Keeps umlauts intact — the
    /// map contains both umlaut and ae/oe/ue spellings so a
    /// diacritic-strip pass is unnecessary (and would conflate "Möhre"
    /// with "Mohre" which is not a word).
    ///
    /// Note: no <c>string.Normalize(FormC)</c> pass — it was a no-op
    /// for our diacritics-preserved map and was the only place that
    /// could throw <see cref="ArgumentException"/> on malformed UTF-16
    /// input (lone surrogate → 500 on /shopping-list/generate).
    /// </summary>
    private static string Normalise(string input)
    {
        var s = input.Trim();
        s = QuantityPrefix.Replace(s, string.Empty);
        s = BracketedQualifier.Replace(s, " ");
        s = s.ToLowerInvariant();
        // Collapse any double spaces introduced by the bracket strip.
        while (s.Contains("  ", StringComparison.Ordinal))
            s = s.Replace("  ", " ", StringComparison.Ordinal);
        return s.Trim();
    }

    private static IReadOnlyDictionary<string, IngredientCategory> BuildMap()
    {
        var m = new Dictionary<string, IngredientCategory>(StringComparer.Ordinal);

        void Add(IngredientCategory c, params string[] names)
        {
            foreach (var n in names)
            {
                // All keys are lower-cased invariant so the lookup can
                // compare byte-for-byte against the normalised query.
                var key = n.ToLowerInvariant();
                // "Add" (not indexer) surfaces accidental duplicate
                // entries as a startup failure rather than silently
                // overwriting a previous bucket.
                m.Add(key, c);
            }
        }

        // ── Obst & Gemüse (~45) ────────────────────────────────────
        Add(IngredientCategory.ObstGemuese,
            "tomate", "tomaten", "kirschtomaten", "cocktailtomaten",
            "gurke", "gurken", "salatgurke",
            "zwiebel", "zwiebeln", "rote zwiebel", "rote zwiebeln",
            "frühlingszwiebel", "frühlingszwiebeln", "lauchzwiebel", "lauchzwiebeln",
            "knoblauch", "knoblauchzehe", "knoblauchzehen",
            "karotte", "karotten", "möhre", "möhren", "moehre", "moehren",
            "lauch", "porree",
            "spinat", "babyspinat", "rucola",
            "salat", "kopfsalat", "feldsalat", "eisbergsalat", "romana",
            "paprika", "paprikaschote", "pfefferschote",
            "avocado", "avocados",
            "apfel", "äpfel", "aepfel",
            "birne", "birnen",
            "banane", "bananen",
            "zitrone", "zitronen", "limette", "limetten",
            "orange", "orangen",
            "beeren", "erdbeeren", "himbeeren", "blaubeeren", "heidelbeeren", "brombeeren",
            "brokkoli", "blumenkohl", "rosenkohl",
            "kartoffel", "kartoffeln", "süßkartoffel", "süßkartoffeln", "suesskartoffel", "suesskartoffeln",
            "pilze", "champignons", "steinpilze", "pfifferlinge",
            "ingwer",
            "aubergine", "auberginen",
            "zucchini", "kürbis",
            "spargel", "sellerie",
            "petersilie", "petersilie frisch",
            "koriander", "koriander frisch",
            "basilikum", "basilikum frisch",
            "dill", "schnittlauch",
            "mais", "maiskolben",
            "radieschen", "rettich",
            "rote bete", "rote beete",
            "erbsen", "bohnen", "grüne bohnen");

        // ── Trockenwaren (~30) ──────────────────────────────────────
        Add(IngredientCategory.Trockenwaren,
            "mehl", "weizenmehl", "dinkelmehl", "vollkornmehl", "roggenmehl",
            "self rising flour", "self-rising flour",
            "reis", "basmati", "basmatireis", "jasminreis", "risottoreis", "arborio",
            "nudeln", "spaghetti", "penne", "fusilli", "tagliatelle", "rigatoni",
            "makkaroni", "lasagneplatten", "lasagne-platten",
            "linsen", "rote linsen", "berglinsen",
            "kichererbsen", "schwarze bohnen", "weiße bohnen", "weisse bohnen", "kidneybohnen",
            "couscous", "bulgur", "quinoa", "haferflocken",
            "zucker", "brauner zucker", "rohrzucker", "puderzucker",
            "salz", "meersalz");

        // ── Gewürze (~35) ───────────────────────────────────────────
        Add(IngredientCategory.Gewuerze,
            "pfeffer", "schwarzer pfeffer", "weißer pfeffer", "weisser pfeffer",
            "paprikapulver", "geräuchertes paprikapulver", "paprika edelsüß", "paprika edelsuess",
            "chilipulver", "chiliflocken", "cayennepfeffer",
            "knoblauchpulver", "zwiebelpulver", "knoblauchsalz",
            "kreuzkümmel", "kreuzkuemmel", "kümmel", "kuemmel",
            "kurkuma", "zimt", "muskat", "muskatnuss",
            "lorbeerblatt", "lorbeerblätter", "lorbeer",
            "rosmarin", "thymian", "oregano", "majoran",
            "italienische gewürzmischung", "italienische kräuter",
            "currypulver", "curry", "garam masala",
            "sternanis", "nelken",
            "vanille", "vanilleextrakt", "vanillepaste",
            "sesam", "sesamsamen",
            "chiliöl", "chilioel",
            "tabasco", "sriracha",
            "safran", "anis", "piment");

        // ── Molkerei (~20) ──────────────────────────────────────────
        Add(IngredientCategory.Molkerei,
            "milch", "vollmilch", "magermilch", "h-milch", "buttermilch",
            "joghurt", "naturjoghurt", "griechischer joghurt",
            "butter", "süßrahmbutter", "suessrahmbutter",
            "sahne", "schlagsahne", "saure sahne",
            "creme fraiche", "crème fraîche", "schmand",
            "quark", "magerquark", "speisequark",
            "frischkäse", "frischkaese",
            "mozzarella", "büffelmozzarella",
            "cheddar", "feta", "parmesan", "gouda", "emmentaler", "ricotta");

        // ── Fleisch & Fisch (~20) ───────────────────────────────────
        Add(IngredientCategory.FleischFisch,
            "hackfleisch", "rinderhack", "schweinehack", "gemischtes hack",
            "hähnchen", "haehnchen", "hähnchenbrust", "haehnchenbrust",
            "hähnchenschenkel", "haehnchenschenkel", "hähnchenkeule", "haehnchenkeule",
            "rindfleisch", "rinderfilet", "rindersteak",
            "schwein", "schweinefilet", "schnitzel", "steak",
            "bacon", "speck", "schinken", "salami", "chorizo",
            "lachs", "lachsfilet", "räucherlachs", "raeucherlachs",
            "thunfisch", "kabeljau", "forelle",
            "garnelen", "shrimps");

        // ── Backen & Süßes (~15) ────────────────────────────────────
        Add(IngredientCategory.BackenSuess,
            "backpulver", "natron",
            "hefe", "trockenhefe", "frischhefe",
            "vanillezucker",
            "schokolade", "zartbitter", "zartbitterschokolade", "vollmilchschokolade",
            "kakao", "kakaopulver",
            "haselnüsse", "haselnuesse",
            "mandeln", "mandelblättchen", "mandelblaettchen",
            "walnüsse", "walnuesse",
            "honig", "ahornsirup", "agavendicksaft",
            "marzipan", "schokoladenstreusel", "schokostreusel");

        // ── Konserven & Fertig (~20) ────────────────────────────────
        Add(IngredientCategory.KonservenFertig,
            "dosentomaten", "gehackte tomaten", "passierte tomaten", "tomaten aus der dose",
            "tomatenmark",
            "kokosmilch",
            "brühe", "bruehe", "gemüsebrühe", "gemuesebruehe", "hühnerbrühe", "huehnerbruehe",
            "rinderbrühe", "rinderbruehe", "fond", "gemüsefond", "gemuesefond",
            "ketchup",
            "senf", "dijon-senf", "dijon senf", "körniger senf",
            "mayo", "mayonnaise", "leichte mayonnaise",
            "essiggurken", "gewürzgurken", "gewuerzgurken",
            "kapern", "oliven", "schwarze oliven", "grüne oliven");

        // ── Getränke & Öle (~15) ────────────────────────────────────
        Add(IngredientCategory.GetraenkeOele,
            "olivenöl", "olivenoel",
            "rapsöl", "rapsoel",
            "sesamöl", "sesamoel",
            "sonnenblumenöl", "sonnenblumenoel",
            "erdnussöl", "erdnussoel",
            "essig", "balsamico", "balsamicoessig", "weißweinessig", "weissweinessig",
            "reisessig", "apfelessig",
            "sojasauce", "sojasosse", "tamari",
            "fischsauce",
            "weißwein", "weisswein", "rotwein", "kochwein", "mirin", "sake");

        // ── Tiefkühl & Brot (~12) ───────────────────────────────────
        Add(IngredientCategory.TiefkuehlBrot,
            "tk-erbsen", "tk-spinat", "tk-beeren", "tiefkühlerbsen", "tiefkuehlerbsen",
            "toastbrot", "brötchen", "broetchen", "baguette",
            "fladenbrot", "pita", "pitabrot",
            "tortillas", "wraps", "tortilla-wraps");

        // ── Haushalt — empty by default (user-added only) ───────────
        // Staples like "Spülmittel" or "Klopapier" are never on a
        // recipe, so we leave the bucket empty in the static map; the
        // endpoint-AddItem path exposes the category for manual use.

        return m;
    }
}
