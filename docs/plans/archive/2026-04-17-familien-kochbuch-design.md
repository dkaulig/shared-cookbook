# Familien-Kochbuch — Design & Product Requirements

**Datum:** 2026-04-17
**Status:** Design abgeschlossen, implementierungsbereit
**Scope:** Privat / Hobby — kein kommerzielles Produkt
**Sprache der App:** Deutsch (keine Mehrsprachigkeit geplant)

---

## Inhalt

1. [Vision & Ziele](#1-vision--ziele)
2. [Zielgruppe & Use Cases](#2-zielgruppe--use-cases)
3. [Phasen-Roadmap (Überblick)](#3-phasen-roadmap-überblick)
4. [Phase 1 — Familien-Kochbuch](#4-phase-1--familien-kochbuch)
5. [Phase 2 — AI-Assistenten](#5-phase-2--ai-assistenten)
6. [Phase 3 — Meal Planning](#6-phase-3--meal-planning)
7. [Phase 4 — Smart-Features](#7-phase-4--smart-features)
8. [Datenmodell](#8-datenmodell)
9. [Architektur](#9-architektur)
10. [Auth & Einladungen](#10-auth--einladungen)
11. [Deployment & Hosting](#11-deployment--hosting)
12. [Phase 0 — Validierungs-Plan](#12-phase-0--validierungs-plan)
13. [Non-Goals](#13-non-goals)
14. [v2-Kandidaten](#14-v2-kandidaten)
15. [Offene Fragen](#15-offene-fragen)

---

## 1. Vision & Ziele

### Vision

Ein digitales Familien-Kochbuch, in dem sich Rezepte **von echten Menschen für echte Menschen** sammeln — nicht redaktionell kuratiert, sondern aus dem Alltag und der Tradition derer, die miteinander kochen. Das Herzstück ist eine gemeinsame Rezept-Sammlung, die innerhalb von Familien- oder Freundeskreisen wächst. In ihr verbinden sich Generationen-Wissen (Omas Schnitzel), Alltags-Favoriten (unsere Wochen-Klassiker) und Social-Media-Funde (das eine Reel von gestern) zu einem verlässlichen, durchsuchbaren Pool.

Das Alleinstellungsmerkmal ist die **Überbrückung zwischen flüchtiger Social-Media-Inspiration und verlässlich nachvollziehbarem Rezept**: Ein Facebook-Reel, das einem heute durchs Gedächtnis flackert, landet in zwei Minuten als sauberes, strukturiertes Rezept in der eigenen Sammlung — mit Zutaten, Schritten, Nährwert-Schätzung und optionaler Verknüpfung zur Original-Quelle.

### Ziele

1. **Rezepte nicht mehr verlieren** — zentrale Ablage statt WhatsApp-Screenshots, Instagram-Bookmarks, Notizen-Listen und Zettel-Stapel.
2. **Familientradition bewahren** — Omas Rezepte dauerhaft archivieren und über Generationen teilbar machen.
3. **Video-zu-Rezept als Killer-Feature** — Facebook-URL rein, strukturiertes Rezept raus (immer mit Review-Schritt).
4. **Entscheidungs-Hilfe im Alltag** — "Was kochen wir heute?" durch Filter, Bewertungen und später AI-gestützte Wochenplanung beantworten.
5. **Einkaufen vereinfachen** — aus Wochenplänen automatisch Einkaufs-Listen generieren.

### Nicht-Ziele (explizit ausgeschlossen)

- Kein kommerzielles Produkt, keine Monetarisierung, kein Marketing-Kanal.
- Keine öffentliche Rezept-Plattform — alles bleibt im Kreis der eingeladenen User.
- Keine Cloud-Skalierung auf tausende User — ein kleiner Hetzner-Server reicht.

### Erfolgs-Kriterium

Die App gilt als erfolgreich, wenn David und seine Familie sie im Alltag benutzen: Rezepte per Video-Link hinzufügen, gemeinsam an der Sammlung arbeiten und sonntags mit der Wochenplan-Funktion den Speiseplan fürs kommende machen.

---

## 2. Zielgruppe & Use Cases

### Zielgruppe

Primär: **Der Eigentümer und seine Familien-/Freundeskreise**, mit Raum für organisches Wachstum über Invites. Realistische Nutzer-Zahl: **10–50 Personen** in den ersten 1–2 Jahren, verteilt auf mehrere Gruppen.

### Personas

- **Power-User** — baut die App, importiert Videos, organisiert Gruppen. Nutzt alle Features.
- **Engagierte Nutzer (Partner, enge Familie)** — tragen regelmäßig Rezepte bei, bewerten, beteiligen sich am Wochenplan. UI muss klar sein, aber keine Hand-Haltung nötig.
- **Gelegenheits-Beiträger (Oma, Eltern, Freunde)** — wollen ihr Rezept einbringen und wiederfinden. Minimum-UX: einfaches Formular, Null Lernkurve.

### Kern-Use-Cases

1. **Social-Media-Fund → Rezept** — Während Facebook-Scrollen ein Rezept-Reel sehen, URL kopieren, in App einfügen, AI extrahiert, User reviewt Ergebnis, speichert in gewählter Gruppe. Typisch: Smartphone-Browser.
2. **Oma-Archivierung** — Familien-Rezept wird auf einem von drei Wegen in die Sammlung gebracht: **(a) manuell** per Formular, **(b) per AI-Chat** ("Ich erzähl dir Omas Rezept, du formst es sauber"), oder **(c) durch Fotografieren der handgeschriebenen/gedruckten Rezept-Karte** — Vision-LLM transkribiert und strukturiert. Landet in Familien-Gruppe, bleibt generationenübergreifend. Typisch: Partnerin/Mutter/Oma hat einen Ordner voller Papier-Rezepte, den sie Seite für Seite abfotografiert.
3. **"Was kochen wir heute?"** — Abends vorm Kühlschrank: User filtert nach Tags (schnell, warm, wenig Zutaten) und Bewertungen, drückt "Zufalls-Vorschlag" oder blättert.
4. **Wochen-Planung** — Sonntagnachmittag: User geht die Familien-Sammlung durch, legt 7 Rezepte in den Wochenplan, erzeugt daraus die Einkaufsliste, erledigt Samstags-Einkauf.
5. **Persönliche Modifikation** — Oma-Rezept ist in Familien-Gruppe, User **forkt** es in seine Privat-Gruppe, passt Gewürze an, ohne das Original zu verändern.
6. **Neue Gruppe gründen** — User startet WG-Kochabende, legt Gruppe "WG-Dinner" an, lädt Freunde per Invite-Link ein, beginnt gemeinsame Sammlung.
7. **Tourist-Modus** — User in Italien, App schlägt italienische Klassiker aus eigener Sammlung vor, oder generiert per AI neue (Phase 4).

### Ausserhalb der Zielgruppe

- Profi-Köche, Restaurants, Food-Blogger mit SEO-Ansprüchen
- User, die die App ohne Einladung nutzen wollen
- Nutzer außerhalb des deutschsprachigen Raums

---

## 3. Phasen-Roadmap (Überblick)

**Grundsatz:** Jede Phase ist für sich alleine nutzbar. Nach Phase 1 existiert bereits eine echte Familien-Kochbuch-App. Alles Weitere ist Multiplier, nicht Voraussetzung.

### Phase 0 — Validierung *(≈ 1 Woche)*

Bestätigen, dass Video-Extraktion für reale Beispiele funktioniert, bevor eine Zeile eigener Code geschrieben wird. Siehe Abschnitt 12.

### Phase 1 — Familien-Kochbuch *(≈ 4–6 Wochen)*

Die tragende Basis. Danach: echte App.

- React-Frontend + C#-Backend + Postgres
- Auth (Invite-only) + Gruppen + Gruppen-Einladungen
- Rezept-CRUD (manuelles Formular) mit Tags, Bewertungen, Fotos
- Portions-Umrechnung (User-seitig + Gruppen-Default)
- Volltext-Suche + Filter-UI (tagbasiert)
- Fork-Funktion zwischen Gruppen

### Phase 2 — AI-Assistenten *(≈ 3–4 Wochen)*

- Python-Microservice für Video-Extraktion (eigener Code, `social_recipes` als Referenz) inkl. Website-Fallback via JSON-LD
- AI-Chat zum Rezept-Erfinden (Conversational UI, gleicher Review-Flow wie Video)
- **Foto-Import** (Vision-LLM für Papier-Rezepte, Screenshots, Rezept-Karten; auch handgeschrieben)
- Nährwert-Schätzung durch LLM
- Integration ins C#-Backend per HTTP

### Phase 3 — Meal Planning *(≈ 2–3 Wochen)*

- Wochenplan-UI (Kalender-Grid, Drag & Drop)
- Einkaufsliste aggregiert Zutaten portionsgerecht
- Portions-Defaults aus Gruppen-Einstellung

### Phase 4 — Smart-Features *(laufend / ad hoc)*

- AI-gestützte Wochen-Vorschläge (Saison, Wetter, Tourist-Modus)
- "Was haben wir lange nicht gekocht?"
- Nährwert-Totals im Wochenplan
- Iterativ, je nach tatsächlichem Bedarf

### Zeit-Schätzung realistisch

Side-Project-Tempo, abends & am Wochenende: **Phase 0 + 1 ≈ 2 Monate** bis zur ersten brauchbaren Version. Phase 2 danach ~1 Monat. Phase 3 + 4 jederzeit pausierbar und aufgreifbar.

---

## 4. Phase 1 — Familien-Kochbuch

**Ziel:** Eine voll funktionsfähige Rezept-App — auch ohne AI-Features vollständig nutzbar.

### 4.1 Rezept-Entität (Felder)

- **Basis:** Titel, Beschreibung, Foto(s, max. 3), Portionen, Zubereitungszeit, Schwierigkeit (1–3)
- **Zutaten:** strukturierte Liste — Menge, Einheit, Zutat, optionale Notiz ("fein gehackt")
- **Schritte:** geordnete Liste (Rich-Text pro Schritt, damit fett/Listen funktionieren)
- **Meta:** Tags, Source-URL (optional, für Video-Importe), Notizen
- **Ownership:** zugehörige Gruppe, Ersteller, zuletzt-geändert-von, Fork-Info
- **Versions-Historie light:** letzte 5 Änderungen mit Diff

### 4.2 Tag-System

Vordefinierte **Taxonomie** (Filter-Grundlage):

- **Mahlzeit:** Frühstück, Mittag, Abend, Snack, Dessert
- **Saison:** Frühling, Sommer, Herbst, Winter, ganzjährig
- **Typ:** warm, kalt, deftig, süß, leicht
- **Aufwand:** schnell (<30 min), mittel, aufwendig
- **Diät:** vegetarisch, vegan, glutenfrei, laktosefrei
- **Küche:** deutsch, italienisch, asiatisch, mexikanisch, …

Plus **freie Custom-Tags** ("Omas Rezept", "Geburtstags-Klassiker", "WG-Hit").

### 4.3 Bewertungen

1–5 Sterne, optionaler Kommentar, **pro Gruppen-Mitglied separat**. Durchschnitt + Anzahl sichtbar.

### 4.4 Gruppen

- Name, Beschreibung, optionales Cover-Bild, `default_servings` (siehe 4.5)
- Rollen: **Admin** (Rechte: umbenennen, Mitglieder/Rollen verwalten, Gruppe löschen), **Member** (Rechte: Rezepte anlegen/editieren, Mitglieder einladen, Rezepte bewerten)
- Wiki-Stil **innerhalb** der Gruppe: alle Member können alle Rezepte editieren — Versions-Historie gibt Transparenz
- **Private Sammlung:** implizite Ein-Personen-Gruppe, automatisch für jeden User angelegt

### 4.5 Portions-Umrechnung

**Funktionalität**

- Rezept hat `default_servings` (z.B. 4)
- Detail-UI hat Portions-Regler (±) oder Input oberhalb der Zutaten
- Alle Zutaten-Mengen werden **live proportional skaliert**; Nährwert-Totals rechnen ebenfalls neu
- Reine Ansicht — die Rezept-Quelle wird nicht verändert

**Gruppen-Default** (`Group.default_servings`)

- Pro Gruppe eine Dezimalzahl, frei wählbar (z.B. `2.5` für 2 Erwachsene + 1 Kind)
- Wirkt an drei Stellen:
  1. **Wochenplan-Einträge** nutzen automatisch diesen Wert
  2. **Rezept-Detail-View** zeigt Original, aber Button "Für {Gruppen-Name} umrechnen" als Ein-Klick-Shortcut
  3. **Einkaufsliste** stimmt automatisch mit Familien-Größe

**Edge Cases**

- **Zähl-Einheiten** (1 Knoblauchzehe, 3 Eier): proportional, sinnvoll gerundet, UI-Hinweis bei Halbwerten
- **"Nach Geschmack", "eine Prise"**: nicht skalierbar (Flag `scalable: false`)
- **Bruch-Mengen:** auf 2 Nachkommastellen, dann sinnvoll gerundet

### 4.6 Suche + Filter

- Volltext-Suche über Titel, Zutaten, Notizen
- Multi-Filter: Tags, Bewertungs-Minimum, Zubereitungszeit, Ersteller
- **"Zufall"-Button:** wendet aktuellen Filter an, wählt zufällig
- Sortierungen: neu, am besten bewertet, zuletzt gekocht

### 4.7 Fork zwischen Gruppen

Button "In andere Gruppe kopieren" → Ziel-Gruppe wählen → unabhängige Kopie. Fork-Info als Metadaten erhalten, damit Herkunft nachvollziehbar bleibt.

### 4.8 UI/UX-Prinzipien

- **Mobile-First** — Smartphone ist primärer Use-Case
- Große Touch-Targets, klare Typografie, schnelle Ladezeiten
- Gruppen-Wechsel als prominentes UI-Element
- Komplett deutschsprachig

### 4.9 Explizit NICHT in Phase 1

- AI-Features (Phase 2)
- Wochenplan, Einkaufsliste (Phase 3)
- Nährwerte (kommen mit AI in Phase 2)
- Kommentar-Threads pro Rezept
- Push-Notifications, E-Mail-Benachrichtigungen

---

## 5. Phase 2 — AI-Assistenten

**Ziel:** Drei komplementäre AI-Wege, Rezepte in die Sammlung zu bringen — **Video-Import**, **Chat-basiertes Rezept-Erfinden** und **Foto-Import für Papier-/Karten-Rezepte**. Alle drei münden im **selben Review-Flow**, der den Menschen immer in der Schleife hält.

### 5.1 Video-Import

**User-Flow (Frontend)**

1. User klickt "+ Rezept aus Video importieren"
2. Fügt Facebook-URL ein (später: TikTok, Instagram, YouTube erweiterbar)
3. Ziel-Gruppe auswählen
4. Fortschrittsanzeige während Extraktion (30–120 s)
5. Review-Screen mit editierbaren Feldern (Zutaten, Schritte, Titel, Foto, Quellen-Link)
6. Speichern → Rezept landet in Gruppe

**Pipeline (Python-Microservice)**

1. **`yt-dlp`** → Video-Download + Metadaten (Caption, Description, externe URLs)
2. **`faster-whisper`** → Audio-Transkription (**lokal**, keine API-Kosten, deutsch-tauglich)
3. **Caption-Analyse** → externe URLs extrahieren (typisch: Reels verweisen auf Blog mit Mengen)
4. **Website-Fetch** (wenn URL gefunden) — Multi-Source-Mehrwert, kein separates Feature:
   - `httpx` für den HTTP-Fetch
   - `extruct` / `recipe-scrapers` für **JSON-LD Recipe-Schema** (SEO-Pflicht auf Food-Blogs → direkt strukturiert, oft ohne LLM-Post-Processing)
   - `beautifulsoup4` als Fallback für unstrukturiertes HTML
5. (Optional Phase 2.1) Vision-LLM für Text-Overlays aus Key-Frames
6. **Structuring-LLM** (Azure OpenAI, `gpt-4o-mini`): bekommt **alle Quellen kombiniert** — Audio-Transkript + Caption + Website-Inhalt + optional Overlays → **strukturiertes JSON** (Zutaten, Schritte, Portionen, geschätzte Nährwerte, Tags)
7. Thumbnail als initiales Foto

**Reine Blog-URL-Imports** laufen über denselben Pfad — Schritte 1/2 entfallen, Rest identisch. Das deckt die ursprüngliche Offene Frage #1 automatisch ab.

**Fehler-Handhabung**

- Download fehlgeschlagen (privat/gelöscht): klare Fehlermeldung, manuelles Anlegen angeboten
- Kein Rezept erkennbar: LLM liefert Confidence-Hinweis, UI warnt
- Nicht-deutsche Quelle: trotzdem extrahieren, bei Bedarf übersetzen
- **Zutaten ohne Mengen** (typisch bei Reels mit externem Blog-Link, Phase-0-Learning): Review-UI markiert betroffene Zeilen visuell (gelb, "Menge fehlt"-Badge), User ergänzt vor dem Speichern
- **Website-Fetch fehlgeschlagen** (404, Block, Timeout): Extraktion läuft mit verfügbaren Quellen weiter, UI zeigt Hinweis

### 5.2 AI-Chat zum Rezept-Erfinden

**User-Flow**

1. User öffnet Chat ("Was möchtest du kochen?")
2. Beispiele: "Ich hab Kartoffeln, Quark, Lauch", "vegane Nudeln in 20 Min", "Italienisch für 4"
3. LLM antwortet konversationell, schlägt Rezept vor
4. User iteriert: "mach's vegan", "halbe Menge", "ohne Knoblauch"
5. Button "In Rezept umwandeln" → Strukturierungs-LLM erzeugt JSON
6. Selber Review-Screen wie beim Video-Import → speichern

### 5.3 Foto-Import (Papier / Screenshots)

**User-Flow**

1. User klickt "+ Rezept aus Foto importieren"
2. **Ein oder mehrere Fotos** hochladen (Drag-&-Drop oder Kamera-Capture auf Mobile)
   - Typische Fälle: Oma-Handschrift, alte Rezept-Karten, Screenshot aus einem Kochbuch, PDF-Seite
   - Mehrseitiges Rezept: Fotos in Reihenfolge hochladen
3. Ziel-Gruppe wählen
4. Fortschrittsanzeige (~5–15 s; deutlich schneller als Video, da kein Download/Transkript)
5. Review-Screen mit editierbaren Feldern — identisch zu Video/Chat
6. Speichern

**Pipeline (Python-Microservice)**

- Keine yt-dlp-/Whisper-Schritte
- **Vision-LLM** (Azure OpenAI `gpt-4o` mit Vision) bekommt **alle Fotos als geordnete Sequenz**
- Prompt-Aufgabe: Text transkribieren (auch Handschrift) → in Rezept-Schema strukturieren (Titel, Zutaten mit Mengen, Schritte, Portionen, Zubereitungszeit)
- Fotos werden ins Object Storage gelegt und bleiben als Rezept-Fotos verknüpft (kein separater Upload nötig)

**Besonderheiten**

- **Handschrift**: Moderne Vision-LLMs erkennen deutsche Handschrift meist zuverlässig; bei unsicheren Stellen markiert die UI die betroffenen Zeilen (gelb, "Handschrift unsicher")
- **Alte Maßeinheiten**: "1 Tasse", "1 Kaffeelöffel", "ein Schuss" — LLM behält ursprüngliche Einheit bei und bietet optional Umrechnung im Review (z.B. "1 Tasse → 250 ml?")
- **Mehrseitig**: Vision-LLM sieht die Fotos als zusammenhängendes Dokument; Nummerierung der Fotos gibt Reihenfolge vor

**Fehler-Handhabung**

- Foto nicht lesbar (zu dunkel, verschwommen, gedreht): UI bittet um besseres Bild
- Kein Rezept erkennbar: klare Fehlermeldung, manuelles Anlegen angeboten
- Teilweise erkennbar: so viel wie möglich extrahieren, Lücken klar markieren

### 5.4 Nährwerte (LLM-Schätzung)

Beim Speichern schätzt das LLM **pro Portion** (kcal, Eiweiß, Kohlenhydrate, Fett). UI markiert als "geschätzt" und erlaubt manuelle Korrektur. Kein BLS/Open-Food-Facts-Aufwand.

### 5.5 LLM-Provider: Azure OpenAI

**Begründung**

- **Datenresidenz in Europa** (West Europe / Sweden Central)
- **Gleiche Modelle** wie OpenAI direct (GPT-4o-mini etc.)
- **Enterprise-SLAs** und stabilere Rate-Limits

**Config-Variablen** (in `.env` / GitHub Secrets)

- `AZURE_OPENAI_ENDPOINT` (z.B. `https://mein-kochbuch.openai.azure.com`)
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_STRUCTURING` (z.B. `gpt-4o-mini-prod`)
- `AZURE_OPENAI_DEPLOYMENT_CHAT`
- `AZURE_OPENAI_API_VERSION` (z.B. `2024-10-21`)

**Provider-Abstraktion**

- Dünner Layer im Python-Microservice: `llm_provider.py`
- Interface: `extract_recipe(text)`, `chat(messages)`, `suggest_meal_plan(...)`
- Default-Implementation: `AzureOpenAIProvider`
- Optional später: `OpenAIProvider`, `GeminiProvider` (Config-Wechsel, kein Code-Rewrite)

### 5.6 Architektur-Entscheidungen

- **Python-Microservice** (FastAPI) als eigener Docker-Container neben C#-Backend
- Kommunikation per HTTP, Extraktion läuft als Background-Job (Queue + Polling)
- API-Keys (Azure OpenAI) **nur im Microservice** — nie im Frontend

### 5.7 Explizit NICHT in Phase 2

- Kein direkter Video-Datei-Upload (Videos nur per URL; **Foto-Upload jedoch ist in Scope**, siehe 5.3)
- Kein Voice-Input im Chat (Text genügt)
- Kein Self-Hosting von LLMs

---

## 6. Phase 3 — Meal Planning

**Ziel:** Aus Rezept-Sammlung + Wochenplan wird ein Einkaufs-fertiger Plan, der die "Was kochen wir diese Woche?"-Frage löst — noch ohne AI.

### 6.1 Wochenplan

**Struktur**

- **Ein Plan pro Gruppe**
- Darstellung: 7-Tage-Grid, je Tag optional mehrere Slots (Frühstück, Mittag, Abend)
- Einträge sind **Rezept-Referenzen** + gewünschte Portionen

**Interaktion**

- Rezept aus Sammlung per Drag & Drop oder "+ zu Tag X hinzufügen"
- Portions-Zahl pro Eintrag separat wählbar (default: `Group.default_servings`)
- Einträge verschieben, duplizieren, entfernen
- Wochen-Navigation, Template-Funktion ("Plan der letzten Woche kopieren")

**Sichtbarkeit**

- Alle Gruppen-Mitglieder sehen denselben Plan, jeder darf ändern
- Versions-Historie light (letzte 5 Änderungen)

**Mark-as-cooked**

- Optional: nach dem Kochen abhaken → fließt in "zuletzt gekocht"-Sortierung und in Phase-4-Empfehlungen

### 6.2 Einkaufsliste

**Erzeugung**

- Button "Einkaufsliste erzeugen" aus Wochenplan-View
- Aggregation: alle Zutaten aller Plan-Einträge der Woche, portionsgerecht skaliert
- Gleiche Zutat + gleiche Einheit → summieren
- Gleiche Zutat + unterschiedliche Einheiten → separat (kein automatisches g↔ml-Umrechnen)

**Gruppierung**

- Nach **Zutaten-Kategorien:** Obst/Gemüse, Milchprodukte, Fleisch/Fisch, Trockenware, Gewürze, Sonstiges
- Kategorien initial per LLM oder statische Mapping-Tabelle

**Interaktion**

- Abhaken während des Einkaufs (State serverseitig → Partner sieht Fortschritt live)
- Manuell ergänzen ("1 Flasche Wein, Freitag Besuch")
- Manuell entfernen ("schon zu Hause")

### 6.3 Explizit NICHT in Phase 3

- Keine Supermarkt-API-Integration (Rewe/Edeka)
- Keine Preis-Schätzung
- Keine automatischen Rezept-Vorschläge im Planer (Phase 4)

---

## 7. Phase 4 — Smart-Features

**Charakter:** Keine einmalige Lieferung, sondern **laufende Erweiterungen** je nach tatsächlichem Bedarf. Jedes Feature ist eigenständig und optional.

### 7.1 AI-gestützte Wochenplan-Vorschläge

- Button "AI-Plan vorschlagen" im leeren oder bestehenden Wochenplan
- LLM bekommt Kontext: Rezept-Sammlung der Gruppe, Saison, Wetter, zuletzt gekochte Rezepte, Gruppen-Default-Portionen, Urlaubs-Status
- Vorschlag erscheint als "Schatten-Plan"
- User: "Komplett übernehmen", "Einzelne Tage übernehmen", "Verwerfen", "Alternativer Vorschlag"

### 7.2 Saison- und Wetter-Awareness

- **Saison** aus Datum → priorisiert Rezepte mit passenden Saison-Tags
- **Wetter** via **Open-Meteo API** (kostenlos, kein API-Key)
- User-Standort: Browser-Geolocation oder manueller Heimat-Ort
- Warm + sonnig → kalte/leichte Rezepte; Kalt + Regen → Eintöpfe, Deftiges

### 7.3 Tourist-Modus

- User setzt in Gruppen-Einstellungen "Wir sind in {Land} bis {Datum}"
- Wochenplan-Vorschläge bevorzugen Rezepte mit passendem Küchen-Tag
- Ist die Sammlung zu spärlich → AI-Chat-Flow aus Phase 2 wird angeboten ("Soll ich typisch italienische Klassiker generieren?")

### 7.4 "Lange nicht gekocht"

- Nutzt Mark-as-cooked-Historie aus Phase 3
- "Wiederentdeckung"-Bereich: gut bewertete Rezepte (≥4 Sterne), >4 Wochen nicht gekocht
- Fließt in AI-Vorschläge ein

### 7.5 Nährwert-Totals im Wochenplan

- Aggregiert Nährwert-Schätzungen aller Plan-Einträge
- Zeigt **pro Tag** und **pro Woche** kcal, Eiweiß, Kohlenhydrate, Fett
- **Kein medizinisches Tracking** — UI kommuniziert das klar

### 7.6 Explizit NICHT in Phase 4

- Keine strikte Durchsetzung von Allergie-/Diät-Filtern
- Keine Einkaufs-Optimierung (Budget, Laufwege, Angebote)
- Keine Social-Features (Chat, Likes, Feed)
- Keine App-interne Benachrichtigungen/Reminder

---

## 8. Datenmodell

Vereinfachte Darstellung der wichtigsten Tabellen. Phase-Zuordnung in Klammern.

### 8.1 Identity & Access

**User** (P1)
`id`, `email`, `display_name`, `avatar_url`, `password_hash`, `role` (User | Admin), `created_at`

**AppInvite** (P1)
`id`, `token`, `created_by_user_id`, `email?`, `used_by_user_id?`, `expires_at`, `created_at`

**GroupInvite** (P1)
`id`, `token`, `group_id`, `invited_by`, `invited_user_id`, `status` (Pending | Accepted | Declined), `created_at`

### 8.2 Gruppen

**Group** (P1)
`id`, `name`, `description`, `cover_image_url`, `default_servings: decimal`, `created_at`
*(P4 ergänzt:)* `home_location_zip`, `vacation_country?`, `vacation_until?`

**GroupMembership** (P1)
`user_id`, `group_id`, `role` (Admin | Member), `joined_at`

### 8.3 Rezepte

**Recipe** (P1)
`id`, `group_id`, `created_by`, `title`, `description`, `default_servings: int`, `prep_time_minutes?`, `difficulty` (1–3), `source_url?`, `source_type` (Manual | Video | Chat | Photo), `fork_of_recipe_id?`, `photos: string[]`, `last_cooked_at?`, `created_at`, `updated_at`
*(P2 ergänzt:)* `nutrition {kcal, protein_g, carbs_g, fat_g}?`, `is_nutrition_estimated: bool`

**Ingredient** (P1)
`id`, `recipe_id`, `position`, `quantity: decimal?`, `unit: string`, `name`, `note?`, `scalable: bool`

**RecipeStep** (P1)
`id`, `recipe_id`, `position`, `content` (Markdown)

**Tag** (P1)
`id`, `name`, `category` (Mahlzeit | Saison | Typ | Aufwand | Diät | Küche | Custom)

**RecipeTag** (P1)
`recipe_id`, `tag_id` *(M:N)*

**Rating** (P1)
`id`, `recipe_id`, `user_id`, `stars` (1–5), `comment?`, `created_at`

**RecipeRevision** (P1, Light)
`id`, `recipe_id`, `changed_by`, `change_type` (Created | Edited | Forked), `diff_summary`, `created_at` *(nur letzte 5 pro Rezept)*

### 8.4 Meal Planning

**MealPlanEntry** (P3)
`id`, `group_id`, `recipe_id`, `planned_date`, `meal_slot` (Breakfast | Lunch | Dinner | Snack), `servings: int`, `cooked: bool`, `cooked_at?`

**ShoppingList** (P3)
`id`, `group_id`, `week_start_date`, `created_at`, `finalized_at?`

**ShoppingListItem** (P3)
`id`, `shopping_list_id`, `name`, `total_quantity`, `unit`, `category`, `checked: bool`, `manually_added: bool`

### 8.5 Prinzipien

- **Soft-Delete** über `deleted_at` für Recipe, Group, User — erlaubt Undo
- **Foreign Keys mit `ON DELETE CASCADE`**, wo semantisch eindeutig (z.B. Ingredient → Recipe)
- **Timestamps immer UTC**, Darstellung in lokaler TZ
- **Postgres** als Datenbank (JSON-Felder für `nutrition`, Arrays für `photos`)

---

## 9. Architektur

### 9.1 System-Überblick

```
┌────────────────┐
│   React PWA    │   Browser (Mobile + Desktop)
└────────┬───────┘
         │ HTTPS / REST
         ▼
┌────────────────┐      ┌─────────────────────┐
│  C# Backend    │─────▶│  Python Microservice│
│  ASP.NET Core  │ HTTP │  (FastAPI)          │
│                │      │  yt-dlp / Whisper / │
│                │      │  LLM-Calls          │
└──────┬─────────┘      └─────────┬───────────┘
       │                          │
       ▼                          ▼
┌────────────┐           ┌──────────────┐
│  Postgres  │           │ Azure OpenAI │
└────────────┘           └──────────────┘
       ▲
       │
┌──────┴──────────┐
│  SeaweedFS (S3) │   Fotos, Thumbnails
└─────────────────┘
```

### 9.2 Frontend: React PWA

- **React 19** + TypeScript (stable seit Dez 2024)
- **Vite 6** als Build-Tool
- **Tailwind CSS 4** (Oxide-Engine)
- **TanStack Query v5** (Server-State) + **Zustand** (lokaler State)
- **shadcn/ui** als Komponenten-Basis
- **PWA:** Service Worker für Offline-Read, Home-Bildschirm-Install
- **Mobile-First**; kein SSR (SPA reicht)

### 9.3 Backend: C# / .NET 10

- **.NET 10 LTS** (Nov 2025 Release)
- **ASP.NET Core Minimal API** + **EF Core 10** (Code-First Migrations)
- **Auth:** JWT-Access + Refresh-Token, ASP.NET Identity als User-Store
- **Validation:** FluentValidation
- **Logging:** Serilog (strukturierte JSON-Logs)
- **API-Stil:** REST + JSON; OpenAPI-Spec generiert Frontend-Typen

### 9.4 Python-Microservice

- **Python 3.13** (FastAPI + Pydantic v2)
- **Verantwortlich:** Video-Extraktion (P2), LLM-Calls (Strukturierung, Chat, Planung)
- **Background-Queue:** Arq + Redis
- **Kommunikation:** C# löst Jobs per HTTP aus, Status per Polling oder Server-Sent-Events
- **LLM-API-Keys** (Azure OpenAI) ausschließlich hier

### 9.5 Daten-Schicht

- **Postgres 17** (JSON-Felder, Array-Typen)
- **SeaweedFS** (self-hosted, S3-kompatibles Gateway) für Bilder
- **Redis 7** für Job-Queue + Session-State

### 9.6 Begründung für SeaweedFS statt MinIO

- Kleineres Binary, deutlich weniger RAM
- Single-Node-Modus ohne Overhead
- S3-Gateway kompatibel zu `AWSSDK.S3`
- Eingebautes File-System + S3 + Web-UI in einem Tool
- Horizontal skalierbar falls jemals nötig

### 9.7 Dev & Deployment

- **Mono-Repo:** `frontend/`, `backend/`, `extractor/`, `infra/`
- **Docker-Compose** für lokal und Prod (selbe Compose-File, andere Profile)
- **CI:** GitHub Actions (Lint, Test, Image-Build)

### 9.8 Kern-Architektur-Entscheidungen

1. **Python für Video-/AI-Pipeline** statt C#: Ökosystem-Vorteil
2. **PWA statt Native-App**: ein Code-Base, mobile-genug
3. **Mono-Repo statt Polyrepo**: einfacher CI
4. **SeaweedFS statt Cloud-S3 oder MinIO**: Self-Hosting, leichtgewichtig
5. **Azure OpenAI statt OpenAI direct**: EU-Datenresidenz, stabilere SLAs

---

## 10. Auth & Einladungen

### 10.1 Signup (App-Level)

- **Ausschließlich über AppInvite-Token** — keine offene Registrierung
- Einladender User generiert Invite → erhält URL: `/signup?token=xyz`
- Formular: E-Mail, Passwort, Anzeigename
- Validierung: Token nicht expired + unused → User anlegen → Token als used markieren → auto-login
- Token-Lebensdauer: **14 Tage**, einmalig verwendbar

### 10.2 Login

- E-Mail + Passwort (**Argon2id**-Hash via ASP.NET Identity)
- Rückgabe: **JWT Access-Token** (15 min) + **Refresh-Token** (30 Tage, rotiert)
- Refresh-Token in HTTP-only Cookie, DB-seitig revozierbar
- Rate-Limit: 5 Versuche / Minute / IP

### 10.3 Passwort vergessen

- E-Mail → Token-Link → neues Passwort
- SMTP via einfachem Provider (Posteo, Migadu)

### 10.4 App-Invite-Flow

- **Jeder User** klickt "Jemanden einladen" → optional E-Mail eingeben
- System generiert Token, speichert `AppInvite`-Record
- User teilt URL manuell oder App sendet E-Mail direkt

### 10.5 Gruppen-Invite-Flow (reine In-App)

- Gruppen-Mitglied klickt "Mitglied einladen"
- **Autocomplete-Suche** nach bestehenden App-Usern
- Einladung erscheint im Dashboard des Eingeladenen — akzeptieren / ablehnen
- Keine URL — Empfänger ist bereits in der App

### 10.6 Rollen

**Global Admin** (`User.role = Admin`)

- User sperren/reaktivieren, Invites widerrufen, globale Config
- Initial: via Seed-Skript bei Erst-Installation
- Weitere Admins ernennen möglich

**Gruppen-Admin** (`GroupMembership.role = Admin`)

- Gruppen-Metadaten ändern, Mitglieder entfernen, Rollen vergeben, Gruppe löschen
- Initial: Gruppen-Ersteller

### 10.7 Session-Handling

- **Access-Token nur im JS-Memory** (Zustand/TanStack Query), nicht in localStorage
- **Refresh-Token in HTTP-only Cookie** — überlebt Reload, XSS-sicher
- Bei Page-Reload: Silent-Refresh via `/auth/refresh`
- Bei Refresh: alter Token invalidiert, neuer ausgestellt (Token-Rotation)
- Logout: Refresh-Token serverseitig invalidiert

**Begründung JS-Memory:** XSS-Schutz. Angreifer mit injiziertem JS kann nicht auf HTTP-only Cookies zugreifen, und Access-Token ist max. 15 min gültig.

### 10.8 Sicherheit

- **Argon2id** Passwort-Hashing
- **Rate-Limiting** auf Login + Signup + Password-Reset
- **CSRF-Protection** für State-ändernde Endpoints
- **Security-Headers** via `UseSecurityHeaders`-Middleware

### 10.9 Explizit NICHT in diesem Scope

- Keine Social Logins (Google, Facebook)
- Keine 2FA
- Kein Passwordless / Magic Link (v2-Idee)

---

## 11. Deployment & Hosting

### 11.1 Ziel-Plattform

- **Hetzner Cloud Server**, Standort Falkenstein oder Helsinki (DSGVO + niedrige Latenz)
- Empfehlung: **CX32** (4 vCPU, 8 GB RAM, 80 GB SSD) ~7 €/Monat
- OS: **Debian 12** oder **Ubuntu 24.04 LTS**

### 11.2 Docker-Compose-Setup

Alle Services auf einer Maschine:

```
services:
  caddy       # Reverse-Proxy + Auto-TLS
  frontend    # React PWA (statisch, via Caddy ausgeliefert)
  backend     # .NET 10 ASP.NET Core API
  extractor   # Python FastAPI (yt-dlp, Whisper, LLM)
  postgres    # Postgres 17
  seaweedfs   # S3-kompatibles File-Storage
  redis       # Queue + Session-State
```

### 11.3 TLS & Domain

- Domain nach eigener Wahl (z.B. `kochbuch.kaulig.dev`)
- **Caddy** als Reverse-Proxy → Auto-TLS via Let's Encrypt, Zero-Config-HTTPS

### 11.4 Backup-Strategie

- **Postgres-Dumps** täglich per Cron → SeaweedFS + wöchentlich off-site auf **Hetzner Storage Box** (1 TB ~3 €/Monat)
- **SeaweedFS-Volume** nightly zur Storage Box syncen
- **Hetzner-Snapshot** des Servers monatlich
- Retention: 7 täglich + 4 wöchentlich + 3 monatlich

### 11.5 Monitoring (minimal)

- **Uptime-Kuma** als Container → self-hosted Status-Page
- **Logs:** Serilog (C#) + Python-Logs → Docker-Logs

### 11.6 Secrets-Management

- **Quelle der Wahrheit:** GitHub Actions Secrets (repository-level)
- **Deployment-Flow:**
  1. Push/Merge nach `main` → GitHub Actions baut Images
  2. Deploy-Job SSHt zum Server
  3. Schreibt `.env` aus `${{ secrets.PROD_ENV }}` (multi-line Secret)
  4. `docker compose pull && docker compose up -d`
- **Permissions:** `chmod 0600`, Owner `root`
- **`.env.example`** committet, **`.env`** in `.gitignore`

**Vorteile:**

- Single Source of Truth
- Rotation per GitHub-UI, keine SSH-Session
- Audit-Log (GitHub zeigt Änderungen)
- Disaster Recovery: Re-Deploy rebuilt `.env` automatisch

### 11.7 Update-Strategie

- **Push nach `main` = Auto-Deploy auf Server** (keine Approval-Gates, kein Tag-Gating)
- **Kein Staging/Dev-Server** — eine Instanz
- Kurze Offline-Fenster akzeptabel (Hobby-Scope)

### 11.8 Kosten-Schätzung

| Posten | Kosten/Monat |
| --- | --- |
| Hetzner CX32 | ~7 € |
| Storage Box 1 TB | ~3 € |
| Domain | ~1 € |
| Azure OpenAI API | ~2–5 € |
| **Summe** | **~13–16 €** |

### 11.9 Dev-Setup lokal

- Eigene lokale `.env` aus `.env.example` kopiert
- Lokale Postgres/Redis/SeaweedFS laufen als separates Docker-Compose-Profil
- Azure-OpenAI-Key kann derselbe sein wie Prod (keine Kostendifferenz für Hobby-Scope)

---

## 12. Phase 0 — Validierungs-Plan

**Ziel:** Vor dem ersten Zeile-Code empirisch klären, ob Video-Extraktion zuverlässig genug funktioniert, um Phase 2 zu rechtfertigen.

### 12.1 Vorgehen

**1. Test-Korpus zusammenstellen (30 min)**

- 15–20 Facebook-Video-URLs mit Rezept-Inhalten
- Mix:
  - 5–7 **deutschsprachige** Videos
  - 3–4 **englischsprachige**
  - 3–4 mit **Caption-Text** (einfach)
  - 3–4 **ohne Caption, nur Audio** (hart)
  - 1–2 mit **Text-Overlays**
  - 1–2 aus **privaten Gruppen** (sollten erwartungsgemäß fehlschlagen)
- In Markdown-Datei sammeln

**2. `social_recipes` aufsetzen (1 h)**

- Docker-Container nach README starten
- OpenAI-API-Key hinterlegen (5–10 € Budget)
- Web-UI auf `localhost:5006` öffnen

**3. Durchlauf der Test-URLs (2–3 h)**

- Jede URL durch Extraktor jagen
- Bewertung nach Kriterien:
  - **Titel korrekt?** (ja/nein)
  - **Zutaten-Liste vollständig?** (Prozent erwischt)
  - **Mengen/Einheiten korrekt?** (ja / teilweise / nein)
  - **Schritte verständlich und vollständig?** (1–5)
  - **Nährwert-Schätzung plausibel?** (ja/nein/fehlt)
  - **Gesamt-Nutzbarkeit:** direkt kochbar / mit Review korrigierbar / unbrauchbar

### 12.2 Entscheidungs-Matrix

| Anteil "direkt kochbar + mit Review korrigierbar" | Entscheidung |
| --- | --- |
| ≥ 80% | **Go** für Phase 2 |
| 50–80% | **Go**, aber mit stärker ausgelegtem Review-UI |
| < 50% | **Nicht jetzt** — Killer-Feature verschieben, Phase 1 trotzdem starten |

### 12.3 Artefakte aus Phase 0

- **Testergebnis-Tabelle** in `docs/phase-0-results.md`
- **Go/No-Go-Entscheidung** dokumentiert
- **Gelernte Failure-Modes** für Phase-2-Design

### 12.4 Budget

- **Zeit:** ca. 1 Tag (4–6 h konzentriert)
- **Geld:** 5–10 € OpenAI-API-Credits

### 12.5 Nicht-Ziele Phase 0

- Kein eigener Code
- Keine Qualitäts-Optimierung
- Keine UI-Integration

---

## 13. Non-Goals

**Explizit ausgeschlossen** — bewusste Entscheidungen, die in späteren Diskussionen nicht wieder aufgerollt werden sollten.

### 13.1 Produkt-Scope

- Keine kommerzielle App (kein Freemium, kein Subscription, keine Werbung)
- Keine öffentliche Rezept-Plattform — immer Gruppen-gated
- Keine offene Registrierung — Invite-only bleibt
- Keine Mehrsprachigkeit
- Kein Food-Blogger-Workflow (SEO, Sharing, Public Posting)
- Keine Social-Features (Feeds, Follower, User-Chat)

### 13.2 Platform

- Keine Mobile-Native-App — PWA reicht
- Keine Desktop-App
- Keine Voice-/IoT-Integration

### 13.3 AI / Features

- Keine strikte Allergie-/Diät-Durchsetzung
- Kein Voice-Input im AI-Chat
- Kein Self-Hosting von LLMs
- Kein Video-Datei-Upload (nur URL-basierter Download; Foto-Upload für Papier-Rezepte ist in Phase 2 explizit in Scope)

### 13.4 Einkaufen / Planung

- Keine Supermarkt-API-Integration
- Keine Preis-Schätzung / Angebots-Tracking

### 13.5 Sicherheit / Auth

- Keine 2FA
- Keine Social Logins
- Kein Passwordless / Magic Link

### 13.6 Deployment / Ops

- Kein Kubernetes / Nomad / Swarm
- Keine Cloud-Services (AWS/Azure/GCP außer Azure OpenAI)
- Kein Multi-Region, kein CDN
- Kein Prometheus/Grafana
- **Kein Staging/Dev-Server** — eine Instanz
- Kein Zero-Downtime-Deployment
- Keine Analytics/Tracking (Mixpanel, Posthog, GA)
- Keine Feature-Flags

### 13.7 Content / Moderation

- Keine Content-Moderation — Gruppen-Mitglieder verantworten
- Keine Rezept-Validität-Prüfung (Review-Schritt fängt auf)

### 13.8 Wachstum / Operations

- Kein User-Support-System
- Kein Onboarding-Funnel / Tutorial-Overlay
- Keine Rate-Limits auf Gruppen-/Rezept-Anzahl pro User

---

## 14. v2-Kandidaten

Features, die nicht im 4-Phasen-Plan sind, aber bewusst offen gehalten, weil in einer v2 wertvoll:

### 14.1 Präzise Nährwert-Berechnung (BLS / Open Food Facts)

- **Trigger:** Wenn LLM-Schätzungen sich als zu ungenau herausstellen oder genaues Tracking relevant wird
- **Aufwand:** moderat — Zutaten-Normalisierung + DB-Lookup + Mengenumrechnung

### 14.2 Lagerbestands- / Vorrats-Management

- **Trigger:** Wenn Einkaufsliste intensiv genutzt und "was haben wir schon?" manuell wird
- **Features:** Vorräte-Liste pro Gruppe, automatischer Abzug bei Rezept-Kochen, Reminders bei niedrigem Bestand
- **Aufwand:** hoch — neue Entitäten (`PantryItem`, `PantryTransaction`), UI, State-Management

### 14.3 Weitere potenzielle v2-Themen (nicht commitet)

- Website-URL-Import (JSON-LD / Structured Data)
- iCal-Export des Wochenplans
- Magic-Link-Login
- Mobile-Native-Apps (falls PWA nicht reicht)

---

## 15. Offene Fragen

Fragen, die im PRD-Prozess bewusst nicht final entschieden wurden. Bei Phasen-Implementierung aufgreifen und in `docs/decisions/` als ADR-light festhalten.

### 15.1 Feature-Fragen

1. ~~**Rezept-Blog-Import** (JSON-LD) zusätzlich zum Video-Import~~ — **GELÖST (2026-04-18):** Durch Phase-0-Validierung als **Pflicht-Teil der Pipeline** identifiziert, nicht mehr separates Nebenfeature. Siehe `docs/phase-0-results.md` und Abschnitt 5.1. Reine Blog-URLs laufen durch denselben Pfad.
2. **Duplikat-Erkennung** bei Video-Import — Soft-Warn bei identischer `source_url`.
3. **Edit-Benachrichtigung** — Versions-Historie als passive Transparenz reicht für v1.
4. **Tag-Governance** — jedes Gruppen-Mitglied darf anlegen, Admin konsolidiert.
5. **iCal-Export** Wochenplan — v2-Kandidat.

### 15.2 Technische Fragen

6. **LLM-Default-Provider:** Azure OpenAI (entschieden, siehe Abschnitt 5.4), Modell: `gpt-4o-mini`.
7. **Video-Download-Timeout** (yt-dlp): 5 min Hard-Timeout + "Später erneut versuchen".
8. **Storage-Warnung SeaweedFS:** 70% Log-Warning, 85% E-Mail, 95% Upload-Sperre.
9. **Datenexport (DSGVO):** Self-Service JSON-Download in v1.

### 15.3 Operative Fragen

10. **Gruppen-Archivierung:** Soft-Delete nach 90 Tagen Inaktivität.
11. **Rate-Limit LLM-Kosten:** 20 Extraktionen pro User pro Tag, Admin-konfigurierbar.
12. **Mobile-vs-Desktop-Priorisierung:** Mobile-First, Desktop "funktioniert auch".

---

## Anhang: Quellen & Inspirationen

- **`pickeld/social_recipes`** (GitHub, MIT-Lizenz) — Referenz-Implementierung für Video-Extraktions-Pipeline mit `yt-dlp` + `faster-whisper` + LLM
- **Recime** — kommerzielle Inspiration, besonders 3-stufige Fallback-Kette (Caption → Audio → Website)
- **Pluck Recipes** — Multi-Modal-Ansatz als Referenz (Audio + Text-Overlays + Captions)

---

*Ende des Dokuments.*
