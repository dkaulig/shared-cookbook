# Ops-Runbook — Familien-Kochbuch

Kurz-Dokumentation für Betrieb auf dem Hetzner VPS (CPX41, 16 GB RAM,
8 vCPU). Host: `kochbuch.kaulig.dev`, Deploy-User: `deploy`,
Compose-Root: `/srv/familien-kochbuch`.

Hobby-Projekt-Runbook — kein Enterprise-Ops.

---

## 1. `.env` aus Backup wiederherstellen

Der Deploy-Workflow legt vor jedem Überschreiben eine Kopie unter
`/srv/familien-kochbuch/.env-backups/` ab (die letzten 20 Deploys).
Wenn ein GitHub-Secret (`PROD_ENV`) kaputt geschrieben wurde:

```bash
# 1. Backups auflisten (neuster zuerst)
ssh deploy@kochbuch.kaulig.dev \
  'ls -1t /srv/familien-kochbuch/.env-backups/'

# 2. Gewünschtes Backup zurückkopieren
ssh deploy@kochbuch.kaulig.dev \
  'cp /srv/familien-kochbuch/.env-backups/env-20260419-093012-pre-v0.3.0.bak \
      /srv/familien-kochbuch/.env && \
   chmod 600 /srv/familien-kochbuch/.env'

# 3. Stack neu starten, damit API + Extractor die Variablen neu laden
ssh deploy@kochbuch.kaulig.dev \
  'cd /srv/familien-kochbuch && \
   docker compose -f docker-compose.prod.yml up -d --force-recreate api python-extractor'
```

Danach unbedingt das kaputte `PROD_ENV`-Secret in GitHub korrigieren,
sonst wird es beim nächsten Deploy wieder überschrieben.

---

## 2. `.env` manuell von VPS nach lokal syncen

Wenn `.env` auf dem VPS per Hand erweitert wurde (z. B. neues
Azure-Deployment) und der Stand in GitHub Secrets veraltet ist:

```bash
# Schreibe in ~/.config mit restriktiver umask statt /tmp
# (/tmp ist world-readable; Home-Verzeichnis nicht).
mkdir -p ~/.config/familien-kochbuch
umask 077
scp deploy@kochbuch.kaulig.dev:/srv/familien-kochbuch/.env \
    ~/.config/familien-kochbuch/.env.prod.tmp

# Inhalt sichten, dann ins GH-Secret schieben — via stdin, NICHT --body,
# sonst landet der Klartext-Inhalt in der zsh/bash-History (argv).
gh secret set PROD_ENV < ~/.config/familien-kochbuch/.env.prod.tmp

# Aufräumen — Datei sofort löschen.
rm ~/.config/familien-kochbuch/.env.prod.tmp
```

Hinweis: `shred` ist auf APFS/SSDs weitgehend wirkungslos (Copy-on-Write,
Wear-Levelling). Der Schutz kommt hier aus dem restriktiven `umask 077`
während des Schreibens und der sofortigen Löschung danach.

---

## 3. Hangfire-Dashboard

- URL: <https://kochbuch.kaulig.dev/api/hangfire>
- Auth: Admin-only (Bearer-JWT mit Rolle `Admin` → `AdminOnlyAuthorizationFilter`)
- Worker-Count: Default **2**, via `HANGFIRE_WORKERS` env var überschreibbar
  (siehe `Program.cs` → `AddHangfireServer`).

Nützliche Ansichten: Jobs → Failed (stuck extractions), Recurring Jobs
(`SweepAbandonedStagedPhotos` sollte stündlich laufen).

---

## 4. Python-Extractor Ressourcen-Monitoring

Compose-Limits in `docker-compose.prod.yml`:

- `mem_limit: 8g`
- `cpus: "6.0"`

Whisper large-v3 residentem RAM-Footprint ~3 GB. Live beobachten:

```bash
ssh deploy@kochbuch.kaulig.dev 'docker stats shared-cookbook-python-extractor --no-stream'
```

Worauf achten:

- **MEM % > 80 %** während Video-Transcription → normal (Whisper
  lädt Modell). Bleibt es nach Job-Ende hoch → Memory-Leak-Verdacht.
- **CPU % nahe 600 %** (6 Kerne) → erwartet bei parallelen Whisper-Jobs.
- OOM-Kill würde im `docker compose ps` als `Exited (137)` auftauchen —
  dann mem_limit prüfen und ggf. WorkerCount (in API) temporär auf 1 reduzieren.

---

## 5. Gängige Diagnose-Commands

```bash
# Container-Status auf einen Blick
ssh deploy@kochbuch.kaulig.dev \
  'cd /srv/familien-kochbuch && docker compose -f docker-compose.prod.yml ps'

# Logs — Python-Extractor (letzte 200 Zeilen, folgen mit -f)
ssh deploy@kochbuch.kaulig.dev \
  'docker compose -f /srv/familien-kochbuch/docker-compose.prod.yml logs python-extractor --tail=200'

# API-Logs
ssh deploy@kochbuch.kaulig.dev \
  'docker compose -f /srv/familien-kochbuch/docker-compose.prod.yml logs api --tail=200'

# Health-Check (außen, über Caddy)
curl -fsS https://kochbuch.kaulig.dev/api/health

# Stack nach config-Change neu starten
ssh deploy@kochbuch.kaulig.dev \
  'cd /srv/familien-kochbuch && docker compose -f docker-compose.prod.yml up -d'
```

---

## 6. Smoke-Script gegen Prod ausführen

`scripts/smoke-live.sh` fährt nach jedem Deploy den Happy Path über den
seedenden Orchestrator-Bot (`orchestrator@kochbuch.kaulig.dev`,
Rolle `User`) gegen die echte API. Acht Schritte:

1. Health, 2. Login, 3. Gruppe anlegen, 4. Rezept anlegen,
5. 5★ bewerten, 6. Rezept abrufen + `averageRating` prüfen,
7. Cook-Marker setzen, 8. Cleanup (Rezept + Gruppe löschen).

Bot-Passwort aus der lokal gecachten `.env` (siehe §2) ziehen und als
`SMOKE_BOT_PASSWORD` exportieren — niemals hart im Skript oder in der
Shell-History landen lassen:

```bash
# Bot-Passwort aus dem lokal gecachten .env laden
set -a
source ~/.config/familien-kochbuch/.env.prod.tmp
set +a
SMOKE_BOT_PASSWORD="$ORCHESTRATOR_PASSWORD" scripts/smoke-live.sh
```

`source` respektiert Shell-Quoting und funktioniert mit `KEY=VALUE`,
`KEY="VALUE"` und `KEY='VALUE'`. Nach dem Smoke-Run
`unset ORCHESTRATOR_PASSWORD SMOKE_BOT_PASSWORD` ausführen.

Ausgabe: bei Erfolg `SMOKE PASSED (8/8)`, bei Fehler
`SMOKE FAILED at step N: …`.

Fehler deuten:

- Step 1 → API / Caddy / TLS defekt (Caddy-Logs, `docker compose ps`)
- Step 2 → Bot nicht geseedet (`ORCHESTRATOR_PASSWORD` fehlt in `.env`?)
  oder Passwort falsch
- Step 3–5 → App-Logik (Groups/Recipes/Ratings) — API-Logs prüfen
- Step 6 → Aggregations-/Read-Pfad — Postgres-Verbindung?
- Step 7 → Cook-Marker / Recipe-Update-Pfad
- Step 8 → Soft-Delete — nur Warnung, schlägt den Run nicht fehl

---

## 6.1 Bot-Passwort rotieren

1. VPS: `/srv/familien-kochbuch/.env` editieren
   ```
   ORCHESTRATOR_PASSWORD=neuerWert
   # temporär anhängen:
   ORCHESTRATOR_PASSWORD_ROTATE=true
   ```
2. Container neustarten: `docker compose -f docker-compose.prod.yml restart api`
3. Startup-Log prüfen: `"Orchestrator bot password rotated"`
4. `ORCHESTRATOR_PASSWORD_ROTATE` wieder aus `.env` entfernen (sonst läuft
   jede Startup den Rotate-Pfad)
5. Lokal in `~/.config/familien-kochbuch/.env.prod.tmp` (falls noch
   vorhanden) den neuen Wert eintragen oder neu scpen

---

## 6.2 Chat-Smoke (optional, manuell)

Nach jedem Deploy den CR2/CR4 Chat-Flow gegen Prod verifizieren — der
Python-`/chat`-Turn-Endpoint ist nach CR5 weg, chat läuft nativ über
.NET + Azure OpenAI SSE streaming. `scripts/smoke-chat.sh` (optional,
nicht in CI):

1. `POST /api/auth/login` → Bearer-Token.
2. `POST /api/chat/sessions` → `sessionId`.
3. `POST /api/chat/sessions/{id}/turn` mit `{ "content": "Hallo" }` —
   Stream als Text lesen bis zur ersten `event: done`-Zeile.
4. `GET /api/chat/sessions/{id}/messages` → assert `count == 2`
   (ein User-Turn + ein Assistant-Turn mit aufgebautem Inhalt).
5. `DELETE /api/chat/sessions/{id}` → 204.

Bei Step 3 länger als ~15 s ohne Token → Azure-Quota oder Caddy
buffert (`X-Accel-Buffering: no` muss durchgereicht sein). Bei Step 4
leerer Assistant-Turn → Server hat den Stream abgebrochen ohne das
Teil-Delta zu persistieren; Api-Logs nach `Turn_Stream_Ending` grep'en.

`/chat/{session_id}/to-recipe` wird weiterhin Python-proxied und
separat über die "Als Rezept speichern"-Button-Flow im UI getestet.

---

## 7. SignalR / Live-Sync Hub

Der `/api/hubs/live` Hub pusht Meal-Plan- und Einkaufslisten-Änderungen
in Echtzeit an alle Gruppen-Mitglieder (P3-8). Auth läuft über JWT —
der Browser kann beim WebSocket-Upgrade keinen `Authorization`-Header
setzen, daher reicht der Client das Token als `?access_token=...`
Query-Param nach. Drei Ops-Konsequenzen:

1. **Caddy-Access-Logs maskieren den Hub-Pfad** — `log_skip /api/hubs/live*`
   in `infra/Caddyfile.prod` unterdrückt die per-Request-Logs für den
   Hub, damit der JWT nicht auf Platte landet. Fehler gehen weiterhin
   über stderr an Docker-Logs. Wenn der Hub-Traffic später mal
   analysiert werden soll, stattdessen auf eine `query_string`-Transform
   umstellen, die den `access_token`-Wert durch `REDACTED` ersetzt —
   NICHT einfach `log_skip` entfernen.

2. **Token-Expiry mitten in einer Verbindung** — bekannte SignalR-
   Limitation: ein JWT, das zur Verbindungszeit gültig war, wird nicht
   revalidiert solange die Verbindung steht. Mitigation: JWT-TTL auf
   15 min lassen (aktueller `Jwt:AccessTokenLifetimeMinutes`); beim
   nächsten Reconnect wird das abgelaufene Token abgewiesen und der
   Frontend-Retry (`reconnectBackoff.ts`) stoppt bei `401` nach
   3 Versuchen — der Nutzer muss sich dann neu einloggen. Code-Pfad
   unter `apps/web/src/features/live/`.

3. **Rate-Limit** — `POST /api/hubs/live/negotiate` ist per-IP auf
   30/min gekappt (`RateLimitPolicies.Hub` in `Program.cs`) — schützt
   den JWT-Validierungs-Pfad vor Anonymous-Floods, ist aber großzügig
   genug für Reconnect-Bursts nach einem Netzwerk-Blip.

---

## 7.1 Deploy-Recovery — Container crash-loop nach Deploy

Wenn nach einem Deploy ein Container (typischerweise `api`) crash-loopt
mit `SIGSEGV` / exit 139 und die Logs DNS-Fehler wie `SocketException
(11): Resource temporarily unavailable` auf Container-Hostnamen
(`postgres`, `python-extractor`) zeigen:

**Ursache**: Der Compose-File (meist `networks`-Block / IPAM-Subnet) hat
sich geändert, aber `docker compose up -d` hat das embedded-DNS
(127.0.0.11) nicht refreshed — die Container laufen im neuen Subnet,
können sich gegenseitig aber nicht mehr per Name auflösen.

Seit v0.4.3 macht `deploy.yml` automatisch ein `compose down` wenn der
SHA-256-Hash von `docker-compose.prod.yml` sich gegenüber dem letzten
erfolgreichen Deploy ändert (`.last-compose-hash` auf dem VPS). Für
Fälle wo das nicht greift (manuelles edit auf VPS, hash-file gelöscht,
…):

```bash
ssh deploy@kochbuch.kaulig.dev
cd /srv/familien-kochbuch
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

Danach prüfen:

```bash
docker compose -f docker-compose.prod.yml ps
curl -fsS https://kochbuch.kaulig.dev/api/health
```

---

## 8. `/api/internal/*` Endpoints (PV1–PV4)

Der Python-Extractor meldet Fortschritt per HTTP-Callback an die .NET-API
zurück: `POST /api/internal/imports/{importId}/progress`. Der Pfad ist
**ausschließlich intern** — extern antwortet er immer `404`.

**Verteidigungs-Schichten (defense in depth):**

1. **Caddy**: `@internal path /api/internal/*` → `respond 404` in
   `infra/Caddyfile.prod`. Externe Requests treffen Kestrel nie.
2. **.NET `InternalOnlyMiddleware`**: CIDR-Allowlist auf das Docker-
   Bridge-Subnet. Das Subnet ist in `docker-compose.prod.yml` auf
   `172.28.0.0/16` gepinnt — sonst würde Docker aus seinem Default-Pool
   (`172.19+`) greifen und die Middleware würde legitime Extractor-Calls
   aussperren. Beide Werte MÜSSEN matchen.

**HMAC-Token**: pro Import einmalig, signiert `{importId, expiresAt}` mit
`EXTRACTOR_SHARED_SECRET`, **10 min TTL** (siehe
`ImportProgressTokenService.MaxTokenLifetime`). Beide Container müssen das
gleiche Secret aus `.env` lesen — mismatch → 401 auf jedem Callback.

### Troubleshooting

- **Imports hängen bei Progress = 10** — der Python→.NET-Callback kommt
  nicht an. Ursachen & Checks:
  ```bash
  # 1. Python-Logs auf HTTP-Fehler oder SsrfBlockedError
  ssh deploy@kochbuch.kaulig.dev 'docker logs shared-cookbook-python-extractor --tail=200 | grep -E "progress|callback|Ssrf"'
  # 2. Subnet-Pin prüfen (muss 172.28.0.0/16 sein)
  ssh deploy@kochbuch.kaulig.dev 'docker network inspect familien-kochbuch_default | jq ".[0].IPAM.Config"'
  # 3. Shared-Secret auf beiden Containern vergleichen (Hash statt Klartext)
  ssh deploy@kochbuch.kaulig.dev 'for c in shared-cookbook-api shared-cookbook-python-extractor; do
    docker exec "$c" sh -c "printenv EXTRACTOR_SHARED_SECRET | sha256sum"; done'
  ```

- **".NET-Logs: Unbekannter importId"** — der Callback kam an, aber die
  `RecipeImport`-Zeile wurde inzwischen gelöscht (z. B. Gruppe gelöscht
  während Import lief). Harmlose Race, kein Action-Item.

- **HTTP 429 / Rate-Limit auf Callbacks** — Python flutet. Deutet auf
  einen Infinite-Loop-Bug im Callback-Scheduler hin (ProgressReporter sollte
  throttled sein, siehe `apps/python-extractor/src/extractor/progress.py`).
  Extractor-Container neu starten und Logs beobachten.

- **Token expired** — 10-min-TTL überschritten. Entweder ein einzelner Import
  dauert >10 min (sehr großes Video → yt-dlp/Whisper langsam) ODER
  Clock-Skew zwischen den Containern:
  ```bash
  ssh deploy@kochbuch.kaulig.dev 'for c in shared-cookbook-api shared-cookbook-python-extractor; do
    echo "$c: $(docker exec "$c" date -u)"; done'
  ```
  Bei >5 s Drift: Host-Zeit via `timedatectl` prüfen, Docker neu starten.

- **UI-Banner "Import reagiert nicht"** — `lastProgressAt` ist älter als
  2 min (`StaleBanner` in `apps/web/src/features/imports/`). Worker ist
  abgestürzt oder steckt im Netzwerk-Blackhole. Manueller Retry via
  "Neu starten"-Button im UI — das navigiert auf
  `/rezepte/import/url?url=<sourceUrl>` und legt einen frischen Import an.

### Post-Deploy-Verifikation

Nach jedem Deploy den Progress-Flow End-to-End prüfen — neben dem 8-Step-
CRUD-Smoke fährt das Skript auch den URL-Import inkl. Phasen-Assertion:

```bash
SMOKE_BOT_PASSWORD="$ORCHESTRATOR_PASSWORD" \
  scripts/smoke-live.sh --import-url="https://www.facebook.com/share/r/<kurz-clip>"
```

Erwartete Ausgabe am Ende: `Observed N distinct phases: [queued downloading transcribing structuring post_processing done]`
mit `N ≥ 3`. Weniger Phasen → der Progress-Callback ist stummgeschaltet
(siehe Troubleshooting oben).

---

## 9. Offline-Verhalten (Phase 5)

Der Client ist eine PWA mit Workbox-Service-Worker + TanStack-Query-
Persistierung in IndexedDB. Auf dem Küchen-Tablet mit WLAN-Loch bleibt
die App nutzbar, Mutationen werden gequeued und nach Reconnect
automatisch repliziert.

**Welche GETs überleben offline** (Workbox `runtimeCaching` in
`apps/web/vite.config.ts`):

- `/api/recipes/*`, `/api/groups/*` — NetworkFirst mit 2 s Timeout,
  dann Cache (`fk-recipes`, 100 Entries, 7 Tage TTL).
- `/api/photos/*` — CacheFirst (`fk-photos`, 50 Entries, 14 Tage
  TTL), damit gesehene Rezept-Fotos offline erhalten bleiben.
- Andere Endpoints (`/api/mealplans/*`, `/api/shopping-lists/*`,
  `/api/chat/sessions`) cachen NICHT via Workbox, überleben aber
  trotzdem offline — der TanStack-Query-Persister hydratisiert den
  gesamten Query-Cache aus IDB (Key `fk-query-cache`), sodass ein
  Reload im Offline-Zustand die zuletzt gesehene Liste ohne
  Netzwerk-Roundtrip rendert. Ephemere Keys (`['chat', 'messages', …]`,
  `['imports', …]`, `['stagedPhotos', …]`) sind per
  `shouldDehydrateQuery`-Predicate in `src/lib/queryPersister.ts`
  explizit ausgeschlossen.

**Welche Mutationen queuen** (Workbox `BackgroundSyncPlugin` mit Queue
`fk-mutation-queue`, 24 h Retention):

- `PATCH /api/recipes/*`
- `PATCH/POST/DELETE /api/mealplans/*/slots*`
- `PATCH/POST/DELETE /api/shopping-lists/*/items*`
- `POST /api/ratings`

**Was der Nutzer sieht** (`NetworkIndicator` Pill in der Top-Nav,
`apps/web/src/components/layout/NetworkIndicator.tsx`):

- Online + leere Queue → unsichtbar (nur `sr-only` live region).
- Offline → **amber „Offline"**-Pill.
- Online + Queue > 0 → **sky „N wartend"**-Pill mit rotierendem Icon.
- Nach erfolgreichem Replay 2 s lang **grüne „N synchronisiert"**-Pill,
  dann zurück auf idle.

**Was beim Reconnect passiert:** Browser feuert `online`-Event → SW
dreht die BackgroundSync-Queue durch, ruft jeden gequeueten Request
nacheinander auf. Server-Antwort (beliebiger Status) = Eintrag fertig,
Fetch-Reject = Retry. Nach Drain postet der SW
`fk-mutation-replayed` an alle Clients; `useBackgroundSyncMessage`
invalidiert die Query-Prefixes `['recipes']` / `['mealplan']` /
`['shoppinglist']` / `['ratings']` → frischer GET.

**Wie 409 Konflikte ankommen** (OFF3 Backend + OFF4 UI): Jeder
Mutation-Endpoint akzeptiert `If-Match: W/"<id>-<version>"`. Bei
Mismatch → 409 mit Body `{ code: "version_mismatch", currentVersion, current: <dto> }`.
`ConflictDialog` (`apps/web/src/features/_shared/ConflictDialog.tsx`)
bietet „Lokale Version behalten" / „Server-Version übernehmen" /
(nur Rezept) „Manuell zusammenführen" — das sieht der Nutzer nur,
wenn er online ist und gleichzeitig jemand anders denselben Datensatz
geändert hat.

### Bekannte Grenzen

- **Rezept-Create offline blockiert** — staged-Photo-Upload braucht
  Netz (SeaweedFS kann nicht gequeued werden).
- **Chat offline blockiert** — SSE braucht Live-Verbindung, die
  Sessions-Liste bleibt aber aus dem Persister sichtbar.
- **Shared-Device cross-user**: Logout leert die SW-Mutation-Queue
  NICHT. Ein User A, der offline queued, dann sich ausloggt, dann User
  B sich einloggt, würde beim Reconnect A's Mutationen gegen B's
  Session replayen. Mitigation: Logout-Clear-Queue ist als Offline-v2
  Follow-up geplant (siehe `apps/web/vite.config.ts` FOLLOW-UP-
  Kommentar).

### Debug-Hilfen

- **Offline-Simulation**: Chrome DevTools → Application → Service
  Workers → Checkbox „Offline". (Für E2E-Assertions → Playwright-
  Smoke unter `apps/web/e2e/offline.spec.ts`, lokal mit
  `pnpm -C apps/web test:e2e`.)
- **Persistierter Query-Cache inspizieren**: DevTools → Application →
  IndexedDB → `fk-query-cache` (ein Key pro Query-Hash, Wert ist das
  dehydrierte Query-Result).
- **Gequeuete Mutationen inspizieren**: DevTools → Application →
  IndexedDB → `workbox-background-sync` → `fk-mutation-queue`. Jeder
  Request liegt als serialisiertes `Request`-Objekt mit Headers +
  Body.
