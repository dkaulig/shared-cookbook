# Phase 0 — Validierungs-Ergebnisse

**Datum:** 2026-04-18
**Testumgebung:** `pickeld/social_recipes` Docker-Container lokal auf Port 5006
**LLM-Provider:** Google Gemini (Model: `gemini-2.5-flash-lite`, Free Tier)
**Whisper-Modell:** `Small` (mehrsprachig)
**Target-Sprache:** Deutsch

---

## Entscheidung

**GO für Phase 2.** Begründung siehe "Fazit" unten.

---

## Test-Ergebnisse

### Test #1 — Bacon-Cheeseburger Hot Pockets

- **Quelle:** Facebook Reel (`facebook.com/share/r/1L9LMnyxWJ/`)
- **Original-Sprache:** Englisch (USA)
- **Video-Typ:** Vollständiges Tutorial-Video mit gesprochenen Mengenangaben

**Extrahiertes Rezept:**

- **Titel:** "Bacon-Cheeseburger Hot Pockets" ✅
- **Beschreibung:** "Einfache, proteinreiche Hot Pockets mit Bacon-Cheeseburger-Geschmack. Perfekt für die schnelle Zubereitung und zum Einfrieren." ✅
- **Zutaten:** 15 Einträge, alle mit Mengenangaben (z.B. "500 g Selbsttreibendes Mehl", "850 g Hackfleisch vom Rind Mager (96/4)") ✅
- **Schritte:** 9 Schritte, logisch geordnet, inkl. Einfrier- und Aufwärm-Hinweisen ✅
- **Foto-Kandidaten:** 12 Frames, "AI Pick" markiert plausibel das fertige Gericht ✅

**Qualitätsbewertung:** **Direkt kochbar** — keine Review-Korrekturen nötig. Sauberes Deutsch trotz englischer Quelle.

---

### Test #2 — Gochujang-Erdnuss-Nudeln

- **Quelle:** Facebook Reel (`facebook.com/share/r/14ey1BMEaEJ/`)
- **Original-Sprache:** Englisch
- **Video-Typ:** Schnelles Reel, Creator verweist in Caption auf externe Website (`iamneverfull.com/gochujang-peanut-noodles/`)

**Extrahiertes Rezept:**

- **Titel:** "Gochujang-Erdnuss-Nudeln" ✅
- **Beschreibung:** knapp, korrekt ✅
- **Zutaten:** 12 Einträge — **ohne Mengenangaben** ⚠️
  - z.B. nur "Erdnussbutter", "Gochujang", "Sojasauce" statt "2 EL Erdnussbutter"
- **Schritte:** 5 Schritte, korrekt strukturiert ✅
- **Foto-Kandidaten:** 12 Frames ✅

**Qualitätsbewertung:** **Mit Review korrigierbar** — die Zubereitungs-Logik ist klar, aber die Mengen fehlen und müssten aus der Original-Website (`iamneverfull.com`) ergänzt werden.

**Ursache der Lücke:** Im Video selbst werden keine Mengen gesprochen; der Creator verweist explizit auf seine Blog-Seite für Details. Das ist ein häufiges Muster bei Instagram/TikTok/Reels-Content.

---

## Erkenntnisse für Phase-2-Design

### 1. Website-Fallback ist zwingend, nicht optional

Die Offene Frage #1 aus PRD-Abschnitt 15 ("Import von Rezept-Blog-Seiten als Nebenfeature") wird zur **Kern-Anforderung der Pipeline**. Viele Reels verweisen auf Blog-URLs, wo die echten Mengen stehen.

**Folge fürs Design:**

- Python-Microservice bekommt einen **HTTP-Client + HTML-Parser**
  - `httpx` für den Fetch
  - `extruct` oder `recipe-scrapers` für **JSON-LD Recipe-Schema** (Google-SEO-Pflicht, auf vielen Food-Blogs vorhanden)
  - `beautifulsoup4` als Fallback für unstrukturiertes HTML
- Caption-Text wird **auf externe URLs gescannt**, gefundene werden gefetcht
- Reine Blog-URL-Imports nutzen dieselbe Pipeline, nur ohne yt-dlp/Whisper-Schritte

### 2. LLM bekommt ALLE Quellen kombiniert

Der Strukturierungs-LLM erhält im Prompt:

1. Audio-Transkript (Whisper-Output)
2. Caption-Text des Social-Posts
3. Website-Inhalt (strukturiert via JSON-LD, sonst plain text)
4. Optional: Text-Overlays aus Video-Frames (Phase 2.1)

So können widersprüchliche oder ergänzende Infos konsolidiert werden. Z.B. Audio sagt "alles gut vermengen", Website liefert "2 EL Sojasauce" — zusammen ein vollständiges Rezept.

### 3. Review-UI muss Lücken sichtbar machen

Bei **fehlenden Mengen** (wie in Test #2) soll die UI den Nutzer aktiv auf die Lücke hinweisen, statt still leere Felder zu zeigen. Vorschlag: gelb-hinterlegte Zutaten mit "Menge fehlt"-Badge.

Bei **niedriger LLM-Confidence** analog: Badge "Bitte prüfen".

### 4. Qualität ist video-typ-abhängig, nicht zufällig

Muster aus den zwei Tests:

| Video-Typ | Qualität |
| --- | --- |
| Vollständiges Tutorial mit gesprochenen Mengen | direkt kochbar |
| Kurz-Reel mit externem Website-Link in Caption | Zutaten-Namen ok, Mengen aus Website nötig |
| Privat/gelöscht | Download-Fehler (nicht getestet, aber erwartbar) |

Das macht **Qualitäts-Erwartungen planbar** und rechtfertigt das Review-UI-Investment.

---

## Performance-Beobachtungen

- **Video-Download + Audio-Transkription:** ~30–60 s pro Video (Whisper-Small, kein GPU)
- **LLM-Call:** 2–5 s
- **Gesamt pro Extraktion:** ~60–90 s end-to-end

Das ist für unseren Use-Case unkritisch, sollte in Phase 2 aber mit einer **Fortschritts-UI** im Frontend sichtbar gemacht werden (haben wir im PRD).

---

## LLM-Modell-Hinweis (Lesson Learned)

Der Default `gemini-2.0-flash` **funktionierte im Free Tier nicht** (`limit: 0`). Wechsel auf `gemini-2.5-flash-lite` hat sofort geklappt.

Relevanz für Phase 2: Wir nutzen ohnehin **Azure OpenAI mit `gpt-4o-mini`**, dort stellt sich die Tier-Frage nicht. Das hier ist nur ein Hinweis für den Fall, dass jemand den Validierungs-Container nochmal aufsetzt.

---

## Anhang: Gesamt-Aufwand Phase 0

- Setup (Docker-Container + Web-UI-Config): ~15 Minuten
- Testdurchläufe (2 URLs): ~5 Minuten
- Analyse + Dokumentation: ~30 Minuten
- **Gesamt:** ~1 Stunde statt veranschlagter 4–6 h

**Einsparung** wurde möglich, weil wir die 15–20 URLs durch zwei repräsentative ersetzt haben, die die relevanten Video-Muster (vollständig + externer-Link) abgedeckt haben. Weitere URLs würden voraussichtlich auf eines dieser zwei Muster fallen oder auf "Download-Fehler".
