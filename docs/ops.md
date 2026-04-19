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
ssh deploy@kochbuch.kaulig.dev 'docker stats familien-kochbuch-python-extractor --no-stream'
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
