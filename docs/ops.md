# Ops runbook — shared-cookbook

Short documentation for running `shared-cookbook` on the Hetzner VPS
(CPX41, 16 GB RAM, 8 vCPU). Host: `EXAMPLE_HOST`, deploy user:
`deploy`, compose root: `/srv/familien-kochbuch`.

Hobby-project runbook — not enterprise ops.

---

## 1. Restore `.env` from a backup

The deploy workflow writes a copy of `.env` to
`/srv/familien-kochbuch/.env-backups/` before every overwrite (the last
20 deploys are kept). If a GitHub secret (`PROD_ENV`) was clobbered:

```bash
# 1. List backups (newest first)
ssh deploy@EXAMPLE_HOST \
  'ls -1t /srv/familien-kochbuch/.env-backups/'

# 2. Copy the desired backup back into place
ssh deploy@EXAMPLE_HOST \
  'cp /srv/familien-kochbuch/.env-backups/env-20260419-093012-pre-v0.3.0.bak \
      /srv/familien-kochbuch/.env && \
   chmod 600 /srv/familien-kochbuch/.env'

# 3. Restart the stack so API + extractor reload the variables
ssh deploy@EXAMPLE_HOST \
  'cd /srv/familien-kochbuch && \
   docker compose -f docker-compose.prod.yml up -d --force-recreate api python-extractor'
```

Afterwards, also fix the broken `PROD_ENV` secret in GitHub — otherwise
the next deploy will overwrite the recovered `.env` again.

---

## 2. Sync `.env` from VPS back down to local

When `.env` was edited by hand on the VPS (e.g. a new Azure deployment)
and the GitHub Secrets copy is stale:

```bash
# Write into ~/.config with a restrictive umask, not /tmp
# (/tmp is world-readable; the home directory is not).
mkdir -p ~/.config/familien-kochbuch
umask 077
scp deploy@EXAMPLE_HOST:/srv/familien-kochbuch/.env \
    ~/.config/familien-kochbuch/.env.prod.tmp

# Inspect the contents, then push it into the GH secret via stdin —
# NOT --body, which would land the cleartext in zsh/bash history (argv).
gh secret set PROD_ENV < ~/.config/familien-kochbuch/.env.prod.tmp

# Clean up — delete the file immediately.
rm ~/.config/familien-kochbuch/.env.prod.tmp
```

Note: `shred` is largely ineffective on APFS / SSDs (copy-on-write,
wear-levelling). The protection here comes from the restrictive
`umask 077` during write and the immediate delete afterwards.

---

## 3. Hangfire dashboard

- URL: <https://EXAMPLE_HOST/api/hangfire>
- Auth: Admin-only (Bearer JWT with `Admin` role →
  `AdminOnlyAuthorizationFilter`)
- Worker count: defaults to **2**, override via the `HANGFIRE_WORKERS`
  env var (see `Program.cs` → `AddHangfireServer`).

Useful views: Jobs → Failed (stuck extractions), Recurring Jobs
(`SweepAbandonedStagedPhotos` should run hourly).

---

## 4. Python-extractor resource monitoring

Compose limits in `docker-compose.prod.yml`:

- `mem_limit: 8g`
- `cpus: "6.0"`

Whisper large-v3 has a resident RAM footprint of roughly 3 GB. Watch it
live:

```bash
ssh deploy@EXAMPLE_HOST 'docker stats shared-cookbook-python-extractor --no-stream'
```

What to watch for:

- **MEM % > 80 %** during a video transcription → normal (Whisper is
  loading the model). If it stays high after the job ends → suspect a
  memory leak.
- **CPU % near 600 %** (six cores) → expected during parallel Whisper
  jobs.
- An OOM kill shows up in `docker compose ps` as `Exited (137)` —
  inspect `mem_limit` and consider temporarily reducing
  `WorkerCount` (in the API) to 1.

---

## 5. Common diagnostic commands

```bash
# Container status at a glance
ssh deploy@EXAMPLE_HOST \
  'cd /srv/familien-kochbuch && docker compose -f docker-compose.prod.yml ps'

# Logs — Python extractor (last 200 lines, follow with -f)
ssh deploy@EXAMPLE_HOST \
  'docker compose -f /srv/familien-kochbuch/docker-compose.prod.yml logs python-extractor --tail=200'

# API logs
ssh deploy@EXAMPLE_HOST \
  'docker compose -f /srv/familien-kochbuch/docker-compose.prod.yml logs api --tail=200'

# Health check (external, through Caddy)
curl -fsS https://EXAMPLE_HOST/api/health

# Restart the stack after a config change
ssh deploy@EXAMPLE_HOST \
  'cd /srv/familien-kochbuch && docker compose -f docker-compose.prod.yml up -d'
```

---

## 6. Run the smoke script against prod

`scripts/smoke-live.sh` runs the happy path through the seeded
orchestrator bot (`orchestrator@EXAMPLE_HOST`, role `User`)
against the live API after every deploy. Eight steps:

1. Health, 2. Login, 3. Create group, 4. Create recipe,
5. Rate 5★, 6. Fetch recipe + assert `averageRating`,
7. Set cook marker, 8. Cleanup (delete recipe + group).

Pull the bot password from your locally cached `.env` (see §2) and
export it as `SMOKE_BOT_PASSWORD` — never hard-code it in the script
or let it land in shell history:

```bash
# Load the bot password from the locally cached .env
set -a
source ~/.config/familien-kochbuch/.env.prod.tmp
set +a
SMOKE_BOT_PASSWORD="$ORCHESTRATOR_PASSWORD" scripts/smoke-live.sh
```

`source` respects shell quoting and works with `KEY=VALUE`,
`KEY="VALUE"`, and `KEY='VALUE'`. Run
`unset ORCHESTRATOR_PASSWORD SMOKE_BOT_PASSWORD` afterwards.

Output: on success `SMOKE PASSED (8/8)`; on failure
`SMOKE FAILED at step N: …`.

How to read failures:

- Step 1 → API / Caddy / TLS broken (Caddy logs, `docker compose ps`)
- Step 2 → Bot not seeded (`ORCHESTRATOR_PASSWORD` missing in `.env`?)
  or wrong password
- Steps 3–5 → app logic (groups / recipes / ratings) — check API logs
- Step 6 → aggregation / read path — Postgres connection?
- Step 7 → cook marker / recipe-update path
- Step 8 → soft-delete — only a warning, does not fail the run

---

## 6.1 Rotate the bot password

1. On the VPS: edit `/srv/familien-kochbuch/.env`
   ```
   ORCHESTRATOR_PASSWORD=newValue
   # temporarily append:
   ORCHESTRATOR_PASSWORD_ROTATE=true
   ```
2. Restart the container: `docker compose -f docker-compose.prod.yml restart api`
3. Check the startup log: `"Orchestrator bot password rotated"`
4. Remove `ORCHESTRATOR_PASSWORD_ROTATE` from `.env` again (otherwise
   every startup will run the rotate path)
5. Locally update `~/.config/familien-kochbuch/.env.prod.tmp` (if it
   still exists) with the new value, or `scp` it down again

---

## 6.2 Chat smoke (optional, manual)

After every deploy, verify the CR2/CR4 chat flow against prod — the
Python `/chat` turn endpoint went away with CR5; chat now runs natively
through .NET + Azure OpenAI SSE streaming. `scripts/smoke-chat.sh`
(optional, not in CI):

1. `POST /api/auth/login` → bearer token.
2. `POST /api/chat/sessions` → `sessionId`.
3. `POST /api/chat/sessions/{id}/turn` with `{ "content": "Hallo" }` —
   read the stream as text up to the first `event: done` line.
4. `GET /api/chat/sessions/{id}/messages` → assert `count == 2`
   (one user turn + one fully-streamed assistant turn).
5. `DELETE /api/chat/sessions/{id}` → 204.

If step 3 takes longer than ~15 s without a token → Azure quota or
Caddy is buffering (`X-Accel-Buffering: no` must be passed through).
If step 4 yields an empty assistant turn → the server aborted the
stream without persisting the partial delta; grep API logs for
`Turn_Stream_Ending`.

`/chat/{session_id}/to-recipe` is still Python-proxied and is tested
separately through the "Save as recipe" button flow in the UI.

---

## 7. SignalR / live-sync hub

The `/api/hubs/live` hub pushes meal-plan and shopping-list changes in
real time to all group members (P3-8). Auth is JWT-based — the browser
cannot set an `Authorization` header on the WebSocket upgrade, so the
client passes the token as a `?access_token=...` query param. Three
ops consequences:

1. **Caddy access logs mask the hub path** — `log_skip /api/hubs/live*`
   in `infra/Caddyfile.prod` suppresses per-request logs for the hub so
   the JWT does not land on disk. Errors still go through stderr to
   docker logs. If hub traffic ever needs to be analysed, switch to a
   `query_string` transform that replaces the `access_token` value
   with `REDACTED` — DO NOT just remove `log_skip`.

2. **Token expiry mid-connection** — known SignalR limitation: a JWT
   that was valid at connection time is not revalidated as long as the
   connection stays open. Mitigation: keep JWT TTL at 15 min (current
   `Jwt:AccessTokenLifetimeMinutes`); on the next reconnect the
   expired token is rejected and the frontend retry
   (`reconnectBackoff.ts`) stops at `401` after three attempts — the
   user has to log in again. Code path: `apps/web/src/features/live/`.

3. **Rate limit** — `POST /api/hubs/live/negotiate` is capped at 30/min
   per IP (`RateLimitPolicies.Hub` in `Program.cs`) — protects the
   JWT-validation path against anonymous floods, while staying generous
   enough for reconnect bursts after a network blip.

---

## 7.1 Deploy recovery — container crash-loop after a deploy

If after a deploy a container (typically `api`) crash-loops with
`SIGSEGV` / exit 139, and the logs show DNS errors like
`SocketException (11): Resource temporarily unavailable` against
container hostnames (`postgres`, `python-extractor`):

**Root cause**: the compose file (usually the `networks` block / IPAM
subnet) changed, but `docker compose up -d` did not refresh embedded
DNS (127.0.0.11) — the containers run in the new subnet but cannot
resolve each other by name anymore.

Since v0.4.3 `deploy.yml` automatically does a `compose down` whenever
the SHA-256 hash of `docker-compose.prod.yml` changes versus the last
successful deploy (`.last-compose-hash` on the VPS). For cases where
that does not trigger (manual edits on the VPS, hash file deleted,
…):

```bash
ssh deploy@EXAMPLE_HOST
cd /srv/familien-kochbuch
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

Then verify:

```bash
docker compose -f docker-compose.prod.yml ps
curl -fsS https://EXAMPLE_HOST/api/health
```

---

## 8. `/api/internal/*` endpoints (PV1–PV4)

The Python extractor reports progress to the .NET API via HTTP
callback: `POST /api/internal/imports/{importId}/progress`. The path is
**internal-only** — externally it always returns `404`.

**Defence layers (defence in depth):**

1. **Caddy**: `@internal path /api/internal/*` → `respond 404` in
   `infra/Caddyfile.prod`. External requests never reach Kestrel.
2. **.NET `InternalOnlyMiddleware`**: CIDR allowlist scoped to the
   docker bridge subnet. The subnet is pinned to `172.28.0.0/16` in
   `docker-compose.prod.yml` — otherwise docker would draw from its
   default pool (`172.19+`) and the middleware would lock out
   legitimate extractor calls. Both values MUST match.

**HMAC token**: one-shot per import, signs `{importId, expiresAt}` with
`EXTRACTOR_SHARED_SECRET`, **10 min TTL** (see
`ImportProgressTokenService.MaxTokenLifetime`). Both containers must
read the same secret from `.env` — a mismatch → 401 on every callback.

### Troubleshooting

- **Imports stuck at progress = 10** — the Python→.NET callback is not
  reaching the API. Causes & checks:
  ```bash
  # 1. Python logs for HTTP errors or SsrfBlockedError
  ssh deploy@EXAMPLE_HOST 'docker logs shared-cookbook-python-extractor --tail=200 | grep -E "progress|callback|Ssrf"'
  # 2. Verify the subnet pin (must be 172.28.0.0/16)
  ssh deploy@EXAMPLE_HOST 'docker network inspect familien-kochbuch_default | jq ".[0].IPAM.Config"'
  # 3. Compare the shared secret on both containers (hash, not cleartext)
  ssh deploy@EXAMPLE_HOST 'for c in shared-cookbook-api shared-cookbook-python-extractor; do
    docker exec "$c" sh -c "printenv EXTRACTOR_SHARED_SECRET | sha256sum"; done'
  ```

- **".NET logs: unknown importId"** — the callback arrived, but the
  `RecipeImport` row was deleted in the meantime (e.g. group deleted
  while the import was running). Harmless race, no action item.

- **HTTP 429 / rate-limit on callbacks** — Python is flooding. Suggests
  an infinite-loop bug in the callback scheduler (ProgressReporter
  should be throttled, see
  `apps/python-extractor/src/extractor/progress.py`). Restart the
  extractor container and watch the logs.

- **Token expired** — exceeded the 10-min TTL. Either a single import
  takes >10 min (very large video → yt-dlp/Whisper slow) OR there is
  clock skew between the containers:
  ```bash
  ssh deploy@EXAMPLE_HOST 'for c in shared-cookbook-api shared-cookbook-python-extractor; do
    echo "$c: $(docker exec "$c" date -u)"; done'
  ```
  If the drift exceeds 5 s: check host time via `timedatectl`, restart
  docker.

- **UI banner "Import reagiert nicht"** — `lastProgressAt` is older than
  2 min (`StaleBanner` in `apps/web/src/features/imports/`). The worker
  has crashed or is stuck in a network black hole. Manual retry via
  the "Neu starten" button in the UI — it navigates to
  `/rezepte/import/url?url=<sourceUrl>` and creates a fresh import.

### Post-deploy verification

After each deploy, verify the progress flow end-to-end. In addition to
the 8-step CRUD smoke, the script also runs the URL import including
phase assertions:

```bash
SMOKE_BOT_PASSWORD="$ORCHESTRATOR_PASSWORD" \
  scripts/smoke-live.sh --import-url="https://www.facebook.com/share/r/<short-clip>"
```

Expected output at the end: `Observed N distinct phases: [queued downloading transcribing structuring post_processing done]`
with `N ≥ 3`. Fewer phases → the progress callback is muted (see
the troubleshooting section above).

---

## 9. Offline behaviour (Phase 5)

The client is a PWA with Workbox service worker + TanStack Query
persistence in IndexedDB. On the kitchen tablet with a Wi-Fi dead-spot
the app stays usable; mutations are queued and replayed automatically
after reconnect.

**Which GETs survive offline** (Workbox `runtimeCaching` in
`apps/web/vite.config.ts`):

- `/api/recipes/*`, `/api/groups/*` — NetworkFirst with a 2 s timeout,
  then cache (`fk-recipes`, 100 entries, 7-day TTL).
- `/api/photos/*` — CacheFirst (`fk-photos`, 50 entries, 14-day TTL),
  so previously-seen recipe photos remain available offline.
- Other endpoints (`/api/mealplans/*`, `/api/shopping-lists/*`,
  `/api/chat/sessions`) are NOT cached via Workbox, but still survive
  offline anyway — the TanStack Query persister hydrates the entire
  query cache from IDB (key `fk-query-cache`), so a reload while
  offline renders the most recently seen list with no network round
  trip. Ephemeral keys (`['chat', 'messages', …]`, `['imports', …]`,
  `['stagedPhotos', …]`) are explicitly excluded via the
  `shouldDehydrateQuery` predicate in `src/lib/queryPersister.ts`.

**Which mutations queue** (Workbox `BackgroundSyncPlugin` with queue
`fk-mutation-queue`, 24 h retention):

- `PATCH /api/recipes/*`
- `PATCH/POST/DELETE /api/mealplans/*/slots*`
- `PATCH/POST/DELETE /api/shopping-lists/*/items*`
- `POST /api/ratings`

**What the user sees** (`NetworkIndicator` pill in the top-nav,
`apps/web/src/components/layout/NetworkIndicator.tsx`):

- Online + empty queue → invisible (only the `sr-only` live region).
- Offline → **amber "Offline"** pill.
- Online + queue > 0 → **sky "N wartend"** pill with a spinner icon.
- After a successful replay, a **green "N synchronisiert"** pill for
  2 s, then back to idle.

**What happens on reconnect:** the browser fires the `online` event →
the SW drains the BackgroundSync queue, replaying every queued request
in order. Server response (any status) marks the entry done; a fetch
reject triggers retry. After the drain the SW posts
`fk-mutation-replayed` to all clients; `useBackgroundSyncMessage`
invalidates the query prefixes `['recipes']` / `['mealplan']` /
`['shoppinglist']` / `['ratings']` → fresh GETs.

**How 409 conflicts arrive** (OFF3 backend + OFF4 UI): every mutation
endpoint accepts `If-Match: W/"<id>-<version>"`. On mismatch → 409 with
body `{ code: "version_mismatch", currentVersion, current: <dto> }`.
`ConflictDialog` (`apps/web/src/features/_shared/ConflictDialog.tsx`)
offers "Lokale Version behalten" / "Server-Version übernehmen" /
(recipe only) "Manuell zusammenführen" — the user only sees this when
they are online and someone else has changed the same record at the
same time.

### Known limits

- **Offline recipe creation is blocked** — staged-photo upload requires
  the network (SeaweedFS cannot be queued).
- **Chat is blocked offline** — SSE needs a live connection, but the
  sessions list stays visible from the persister cache.
- **Shared-device cross-user**: logout does NOT clear the SW mutation
  queue. A user A who queues offline, logs out, then user B logs in,
  would on reconnect replay A's mutations against B's session.
  Mitigation: clear-queue-on-logout is planned as an Offline-v2
  follow-up (see the FOLLOW-UP comment in `apps/web/vite.config.ts`).

### Debugging helpers

- **Offline simulation**: Chrome DevTools → Application → Service
  Workers → "Offline" checkbox. (For E2E assertions → Playwright
  smoke under `apps/web/e2e/offline.spec.ts`, locally with
  `pnpm -C apps/web test:e2e`.)
- **Inspect the persisted query cache**: DevTools → Application →
  IndexedDB → `fk-query-cache` (one key per query hash; the value is
  the dehydrated query result).
- **Inspect queued mutations**: DevTools → Application → IndexedDB →
  `workbox-background-sync` → `fk-mutation-queue`. Each request is
  stored as a serialised `Request` object with headers + body.
