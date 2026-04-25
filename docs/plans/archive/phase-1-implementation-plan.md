# Phase 1 — Implementation Plan

**Goal:** Produce a fully-functional family recipe web app matching the Phase 1 scope described in `2026-04-17-familien-kochbuch-design.md` (sections 3, 4, 8, 9, 10, 11). Orchestrated autonomously by the assistant; executed by dispatched sub-agents following **TDD** strictly.

**Reference repo for conventions:** `/Users/dkaulig/Projects/hoppr/` (pnpm monorepo, .NET Minimal API with Domain/Infrastructure/Api layers, React 19 + Vite + Tailwind 4, SeaweedFS, Docker Compose). When a sub-agent needs a concrete example of endpoint mapping, DI wiring, EF migration review, test-utilities, Dockerfile layout, etc., inspect the hoppr repo for a pattern to mirror.

**Hard rules for every sub-agent:**

1. **TDD or nothing.** Commit failing tests FIRST, then make them green with implementation. Reviewers check commit order.
2. **Small commits.** Each logical step is one commit. No giant merge-bomb commits.
3. **Push after each commit** to `origin/main`. (Auto-deploy is not wired yet, so safe.)
4. **German UI, English code.** Identifiers, comments, commit messages in English. User-facing strings in German.
5. **No deviation from PRD** without waking the orchestrator.
6. **EF migration review pflicht.** After `dotnet ef migrations add`, inspect the generated `.cs` file — EF sometimes bundles unintended schema changes from other branches. Reject unexpected diffs, re-generate.
7. **Conventions > creativity.** Mirror hoppr patterns unless there's a clear reason.

---

## Technology Versions (from PRD section 9)

| Layer | Tech | Version |
| --- | --- | --- |
| Frontend | React | 19 |
| Build tool | Vite | 6 |
| CSS | Tailwind | 4 |
| UI kit | shadcn/ui | latest (lives in repo) |
| State (server) | TanStack Query | 5 |
| State (local) | Zustand | 5 |
| Backend | .NET | 10 LTS |
| API | ASP.NET Core Minimal API | 10 |
| ORM | EF Core | 10 |
| Auth | ASP.NET Identity + JWT (Argon2id) | — |
| Validation | FluentValidation | 11+ |
| Logging | Serilog | 4+ |
| Database | Postgres | 17 |
| Cache/queue | Redis | 7 |
| Object storage | SeaweedFS | latest |
| Reverse proxy | Caddy | 2 |
| Monorepo | pnpm workspaces | 10 |
| Runtime | Node | 22+ (present: 25) |
| Tests (web) | Vitest + RTL + MSW | latest |
| Tests (.NET) | xUnit + NSubstitute + SQLite in-memory | latest |

---

## Repository Structure (target)

```
/
├── apps/
│   ├── api/
│   │   ├── Directory.Build.props           # common .NET props (TargetFramework=net10.0, nullable, etc.)
│   │   ├── Dockerfile                      # multi-stage: sdk build → runtime
│   │   ├── FamilienKochbuch.sln
│   │   ├── src/
│   │   │   ├── FamilienKochbuch.Api/               # presentation (Minimal API)
│   │   │   │   ├── Endpoints/                      # MapXxxEndpoints() extensions per feature
│   │   │   │   ├── Services/                       # TokenService, etc.
│   │   │   │   ├── Middleware/                     # RateLimiting, etc.
│   │   │   │   ├── Program.cs
│   │   │   │   └── appsettings.*.json
│   │   │   ├── FamilienKochbuch.Domain/            # entities, enums, value objects
│   │   │   └── FamilienKochbuch.Infrastructure/    # EF Core, persistence
│   │   │       ├── Persistence/
│   │   │       │   ├── AppDbContext.cs
│   │   │       │   ├── Migrations/
│   │   │       │   └── SeedData.cs
│   │   │       ├── Services/
│   │   │       └── Identity/                       # Argon2 password hasher adapter
│   │   └── tests/
│   │       ├── FamilienKochbuch.Domain.Tests/
│   │       ├── FamilienKochbuch.Infrastructure.Tests/
│   │       └── FamilienKochbuch.Api.Tests/         # WebApplicationFactory-based integration
│   └── web/
│       ├── Dockerfile                      # multi-stage: node build → nginx/caddy
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       ├── eslint.config.js
│       ├── tailwind.config.ts
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── routes/                    # React Router routes
│       │   ├── features/                  # feature modules (auth, groups, recipes, etc.)
│       │   ├── components/                # shared UI (shadcn/ui derived)
│       │   ├── hooks/                     # reusable hooks
│       │   ├── lib/                       # api client, utils
│       │   ├── stores/                    # zustand
│       │   └── test/                      # test-utils, MSW handlers
│       └── public/
├── packages/
│   ├── shared/                             # @familien-kochbuch/shared — DTO types, API client
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── types/                      # Recipe, User, Group, etc. TypeScript interfaces
│   │   │   ├── api/                        # typed fetch client
│   │   │   └── utils/                      # scaling math, etc.
│   │   └── tsconfig.json
│   └── config/                             # @familien-kochbuch/config — shared tsconfig, eslint
│       ├── package.json
│       ├── tsconfig.base.json
│       └── eslint.config.base.js
├── infra/
│   ├── Caddyfile                           # dev reverse proxy
│   └── seaweedfs/                          # any seaweedfs config files
├── docker-compose.yml                      # local dev compose (builds from source)
├── docker-compose.prod.yml                 # prod compose (image-based)
├── pnpm-workspace.yaml
├── package.json                            # monorepo root scripts
├── .github/
│   └── workflows/
│       ├── ci.yml                          # test-on-PR (web + api)
│       └── deploy.yml                      # image build + SSH deploy (dormant until server exists)
├── docs/
│   ├── plans/                              # existing PRD + this plan
│   └── phase-1-progress.md                 # live progress tracker (updated by orchestrator)
├── .gitignore
└── README.md
```

---

## Progress Tracker Protocol

A file `docs/phase-1-progress.md` is **the source of truth** for slice state. Every orchestrator wake-up reads and updates it. Every sub-agent ends its run with a commit that updates this file.

Columns: `Slice | State (pending|in_progress|in_review|done|blocked) | Agent | Started | Completed | Notes`.

The orchestrator only stops the heartbeat loop when all 8 slices are in `done` state with green reviews.

---

## The 8 Slices

Each slice spec below is self-contained. A sub-agent receives the slice section verbatim as its task brief, plus the global hard rules above.

### S0 — Monorepo Skeleton & Tooling

**Scope:** Produce a repo that boots end-to-end with `docker compose up` and serves a React "Hello Familien-Kochbuch" page backed by a .NET `/health` endpoint. No business logic yet.

**Deliverables:**

1. `pnpm-workspace.yaml` listing `apps/*` and `packages/*`
2. `package.json` (root) with scripts: `dev`, `build`, `test`, `lint`, `format`
3. `apps/api/` as per structure above:
   - `FamilienKochbuch.sln` with 3 src + 3 test projects
   - `Directory.Build.props` pinning `TargetFramework=net10.0`, `Nullable=enable`, `TreatWarningsAsErrors=true`, `ImplicitUsings=enable`
   - `Program.cs` with a single `GET /health` endpoint returning `{ status: "ok", timestamp: ... }`
   - `appsettings.Development.json` with Postgres + Redis connection strings
   - EF Core packages installed but no migrations yet
   - Serilog configured with console sink
   - xUnit set up in all three test projects with **one smoke test each**
4. `apps/web/`:
   - Vite + React 19 + TS + Tailwind 4
   - `App.tsx` shows "Familien-Kochbuch" headline + calls `/health` via fetch, shows status
   - Vitest + RTL + MSW configured
   - One smoke component test + one integration test (MSW mocks `/health`)
   - shadcn/ui initialized (`components.json` + base components placeholder)
   - Path aliases: `@/` for `src/`
   - PWA manifest stub (`manifest.webmanifest`) — full service worker comes in later slice
5. `packages/shared/`:
   - Exports one dummy type `HealthResponse { status: string; timestamp: string }`
   - Consumed by both `api` (via OpenAPI codegen target; for now hand-written) and `web`
6. `packages/config/`:
   - `tsconfig.base.json` with strict mode
   - `eslint.config.base.js` (flat config, TS-eslint + React)
7. `docker-compose.yml` with services:
   - `postgres` (postgres:17-alpine, volume `postgres-data`, port 5432)
   - `redis` (redis:7-alpine, port 6379)
   - `seaweedfs` (chrislusf/seaweedfs, port 8333, volume `seaweedfs-data`)
   - `api` (build from `apps/api`, port 5000, depends_on postgres + redis + seaweedfs)
   - `web` (build from `apps/web`, port 5173 via Caddy proxy, depends_on api)
   - `caddy` (caddy:2-alpine, ports 80/443, mounts `infra/Caddyfile`)
8. `infra/Caddyfile`:
   - `http://localhost` → route `/api/*` to `api:5000`, rest to `web:5173`
9. `.github/workflows/ci.yml`:
   - Jobs `test-web` (pnpm install → pnpm test) and `test-api` (dotnet test on all 3 test projects), triggered on PR and push to main
10. `README.md`:
    - Dev setup (prereqs, first-run `docker compose up`, test commands)
    - Structure overview
11. `docs/phase-1-progress.md` initialized with all 8 slices in `pending` state (except S0 → `in_progress` at start, `done` at end)

**TDD approach for S0:** Tests are smoke tests — they verify the skeleton compiles and runs. Commit failing tests first (e.g. `/health` returns 200 with `status: "ok"`), then implement.

**Acceptance criteria:**

- [ ] `docker compose up --build` completes without error; all 6 services healthy
- [ ] `curl http://localhost/api/health` returns `{"status":"ok","timestamp":"..."}`
- [ ] `curl http://localhost/` serves the React app HTML
- [ ] `cd apps/web && pnpm test` passes
- [ ] `dotnet test apps/api/FamilienKochbuch.sln` passes
- [ ] `pnpm lint` (root) passes on both web + shared
- [ ] Progress tracker updated to `done` for S0

**Commit sequence (illustrative):**

1. `chore: add monorepo scaffolding (pnpm workspace, root package.json)`
2. `chore(api): add dotnet solution and project skeleton`
3. `test(api): add failing /health endpoint test`
4. `feat(api): implement /health endpoint`
5. `chore(web): init vite react ts tailwind`
6. `test(web): add failing app smoke test`
7. `feat(web): render hello headline with health status`
8. `chore(infra): add docker-compose and caddyfile`
9. `chore: add github actions ci workflow`
10. `docs: add README and progress tracker`

---

### S1 — Auth Foundation

**Scope:** Full signup-via-AppInvite, login, refresh, logout, password-reset flow. Token rotation, Argon2id hashing, rate-limiting. Web auth pages + silent-refresh bootstrap.

**Deliverables:**

**Domain layer:**
- `User { Id, Email, DisplayName, PasswordHash, Role (User|Admin), CreatedAt, DeletedAt? }`
- `AppInvite { Id, Token, CreatedByUserId, Email?, UsedByUserId?, ExpiresAt, CreatedAt }`
- `RefreshToken { Id, UserId, TokenHash, ExpiresAt, RotatedAt?, RevokedAt? }`
- Domain rules encoded as methods or factory functions with unit tests

**Infrastructure layer:**
- `AppDbContext` with `DbSet<User>`, `DbSet<AppInvite>`, `DbSet<RefreshToken>`
- Initial EF migration `InitialAuth` (reviewed per hard-rule 6)
- `Argon2idPasswordHasher` implementing `IPasswordHasher<User>`
- `TokenService`: issues JWT (15 min, HS256 or RS256 config), refresh (30 days, random 64 bytes, stored hashed), rotation logic
- `SeedDataService`: creates initial admin user from env `ADMIN_EMAIL` + `ADMIN_PASSWORD` on startup if no users exist (logs a warning if using defaults)

**API layer:**
- `AuthEndpoints.MapAuthEndpoints(app)` exposing:
  - `POST /auth/signup?token=xyz` — body: `{ email, password, displayName }`. Validates token, creates user, auto-login (sets refresh cookie, returns access token), marks invite used.
  - `POST /auth/login` — body: `{ email, password }`. Rate-limited 5/min/IP. On success sets refresh cookie + returns access token.
  - `POST /auth/refresh` — reads HTTP-only refresh cookie, rotates, returns new access token. Invalidates old refresh.
  - `POST /auth/logout` — revokes refresh token by hash.
  - `POST /auth/password-reset-request` — body: `{ email }`. Sends magic link via SMTP (stubbed interface `IEmailSender` for now; production SMTP config later).
  - `POST /auth/password-reset` — body: `{ token, newPassword }`.
- `InviteEndpoints.MapInviteEndpoints(app)`:
  - `POST /invites/app` — authorized, body: `{ email? }`. Creates invite, returns URL with token.
  - `GET /invites/app/:token` — anonymous, returns `{ valid: bool, expiresAt, inviterDisplayName }` for signup-page preview.
  - `DELETE /invites/app/:id` — authorized (Admin or invite creator), revokes.

**Web layer:**
- Route `/login` — email + password form, error states
- Route `/signup?token=...` — fetches invite preview, shows inviter name, form
- Route `/forgot-password` + `/reset-password?token=...`
- `useAuth()` hook: reads auth state from Zustand store, `login/logout/refresh` methods
- `useSession()` — silent refresh on mount if no access token in memory
- Axios/fetch interceptor: 401 → try refresh → retry original request once; on fail, redirect to login
- `ProtectedRoute` component
- Sidebar showing display name + "Jemanden einladen" button (opens dialog that creates invite via `POST /invites/app` and displays URL to copy)

**Tests (TDD — fail first, then pass):**

Domain:
- User email validation (lowercase, trimmed, valid format)
- DisplayName not blank, not only whitespace

Infrastructure:
- Argon2 hash → verify roundtrip (happy + wrong password)
- TokenService: issued JWT has correct `sub`, `role`, `exp` (use fake IClock)
- RefreshToken rotation: old marked rotated, new returned

API integration (WebApplicationFactory):
- Signup: valid invite → 200 + sets cookie + body has access token; invalid token → 400; expired → 400; used → 400
- Login: correct → 200; wrong pw → 401; 6th attempt in 1 min → 429
- Refresh: valid cookie → 200 + new access + rotated cookie; reused old → 401 + all user's refresh tokens revoked (reuse-detection per OWASP)
- Logout: → 204 + refresh cookie cleared
- Password reset: request sends email (verify via stub spy); reset with valid token updates hash
- Invite: creating → returns unique token; preview works; used invite can't be reused

Web:
- Login form validation (empty, invalid email)
- Login → redirects to home; 401 shows error
- Signup with valid token displays inviter name
- Protected route redirects to login when no access token
- Silent refresh on boot (MSW fakes /auth/refresh)

**Acceptance:**

- [ ] Full end-to-end: signup via invite → login → access protected page → logout → can't access protected → login again works
- [ ] All tests green
- [ ] Rate-limit works (429 on 6th login attempt)
- [ ] Refresh-token reuse is detected and invalidates the family

---

### S2 — Groups & Memberships

**Scope:** Create groups, invite existing users into groups (in-app, not URL), role management, auto-create "Private Sammlung" per user.

**Deliverables:**

**Domain:**
- `Group { Id, Name, Description?, CoverImageUrl?, DefaultServings (decimal, default 2), CreatedAt, DeletedAt? }`
- `GroupMembership { UserId, GroupId, Role (Admin|Member), JoinedAt }` (composite PK)
- `GroupInvite { Id, GroupId, InvitedByUserId, InvitedUserId, Status (Pending|Accepted|Declined), CreatedAt, RespondedAt? }`

**Infrastructure:**
- Migration `AddGroups`
- On user creation: auto-create "Private Sammlung" group with user as sole Admin (domain event + handler, or inline in UserService)

**API:**
- `POST /groups` — creates group, creator = Admin
- `GET /groups` — lists user's groups
- `GET /groups/:id` — detail (members, settings) — auth: must be member
- `PUT /groups/:id` — name, description, cover, default_servings — auth: Admin
- `DELETE /groups/:id` — soft-delete — auth: Admin; rejects if only group (user always has Private Sammlung)
- `POST /groups/:id/invites` — body: `{ invitedUserId }` — auth: any member. Creates pending GroupInvite.
- `GET /groups/invites` — current user's pending received invites
- `POST /groups/invites/:id/accept` / `/decline`
- `GET /groups/:id/members` — auth: member
- `PUT /groups/:id/members/:userId` — role change — auth: Admin
- `DELETE /groups/:id/members/:userId` — auth: Admin OR self (leave group)
- `GET /users/search?q=...&limit=10` — auth: any user. Returns users by partial display name match, excluding already-in-group-X if `exclude=:groupId` query used. Limit 10.

**Web:**
- Route `/groups` — list of my groups (cards with name, description, member count)
- Route `/groups/:id` — detail page (shown during recipe work later)
- Dialog: create group
- Dialog: invite member (autocomplete user search, select, submit)
- Dropdown in top-nav: switch between groups or view all
- Notifications area: pending group invites (accept/decline)

**Tests (TDD):**

Domain:
- Group name required, 1–100 chars
- DefaultServings > 0

Infrastructure:
- Private Sammlung auto-created on user signup
- Group soft-delete cascades to memberships appropriately

API:
- Create group as user A → A is Admin → list shows it
- Invite B → B sees pending → B accepts → B is Member
- B tries to edit group → 403
- B leaves → no longer member
- User search: no match → empty; partial match → returns
- Cannot delete Private Sammlung (reserved)

Web:
- Groups list renders
- Create-group dialog flow
- Invite flow with autocomplete
- Accept invite moves group into list

**Acceptance:**

- [ ] Two users can collaborate on one group via invite flow
- [ ] User can be in multiple groups simultaneously and switch between them
- [ ] Private Sammlung always present, never deletable

---

### S3 — Recipes (Core CRUD)

**Scope:** Recipes with structured ingredients, ordered steps, tags, photos (SeaweedFS), CRUD forms, list + detail views.

**Deliverables:**

**Domain:**
- `Recipe { Id, GroupId, CreatedByUserId, Title, Description?, DefaultServings (int), PrepTimeMinutes?, Difficulty (1-3), SourceUrl?, SourceType (Manual|Video|Chat|Photo, default Manual for Phase 1), ForkOfRecipeId?, Photos (string[]), LastCookedAt?, CreatedAt, UpdatedAt, DeletedAt? }`
- `Ingredient { Id, RecipeId, Position, Quantity (decimal?), Unit (string), Name (string), Note?, Scalable (bool, default true) }`
- `RecipeStep { Id, RecipeId, Position, Content (string, Markdown) }`
- `Tag { Id, Name, Category (Mahlzeit|Saison|Typ|Aufwand|Diaet|Kueche|Custom), CreatedByUserId?, GroupId? }` — predefined tags: `CreatedByUserId=null, GroupId=null` (global). Custom tags: user + group.
- `RecipeTag { RecipeId, TagId }` (composite PK)

**Infrastructure:**
- Migration `AddRecipes` including seed of ~30 predefined tags across the 6 categories
- `IPhotoStorage` interface + `SeaweedFsPhotoStorage` impl: uploads images to SeaweedFS, returns public URL
- Image validation: max 5 MB, allowed types (jpg, png, webp), optional re-encoding (ImageSharp)

**API:**
- `POST /groups/:groupId/recipes` — auth: group member. Creates recipe with ingredients + steps + tags in single transaction.
- `GET /groups/:groupId/recipes?page=&pageSize=` — member-only. Paginated list.
- `GET /recipes/:id` — auth: member of owning group. Returns full recipe.
- `PUT /recipes/:id` — auth: member. Updates all fields. Increments `UpdatedAt`.
- `DELETE /recipes/:id` — auth: member OR admin. Soft-delete.
- `POST /recipes/:id/photos` — multipart upload. Returns URL. Max 3 photos per recipe.
- `DELETE /recipes/:id/photos` — body: `{ photoUrl }` — removes from array + from SeaweedFS

**Web:**
- Route `/groups/:id/recipes` — list view (cards with photo, title, rating preview, tags)
- Route `/groups/:id/recipes/:recipeId` — detail view (hero photo, title, description, portions input, ingredients list, steps list, tags, source link if present)
- Route `/groups/:id/recipes/new` — create form
- Route `/groups/:id/recipes/:recipeId/edit` — edit form
- Form component with:
  - Inline-editable ingredient rows (add/remove, reorder via drag)
  - Quantity input supports decimals; unit dropdown (common units + custom)
  - Scalable toggle per ingredient
  - Steps: ordered list with reorder + markdown textarea
  - Tag multi-select with category grouping + create-custom-tag button
  - Photo drop-zone (up to 3), thumbnails, remove

**Tests (TDD):**

Domain:
- Ingredient: quantity null = "nach Geschmack" scenario (scalable must be false)
- Recipe title required, 1–200 chars
- Position gaps handled (when step deleted, positions not renumbered)

Infrastructure:
- Seeded tags exist after migration
- Photo upload goes to SeaweedFS (use fake impl in tests)

API:
- Create recipe with ingredients + steps + tags → get same back
- Update recipe replaces ingredients (not deep-merge) — decision: full replace per PUT semantics
- List respects group membership (non-member → 403)
- Photo upload returns URL; 4th photo → 400

Web:
- Recipe form validation (title required, etc.)
- Add/remove ingredient rows
- Tag picker renders categories
- Photo upload flow via MSW

**Acceptance:**

- [ ] User can create a recipe with 10+ ingredients, 5+ steps, 3 tags, 2 photos
- [ ] Edit, save, re-render shows identical data
- [ ] Delete soft-deletes (not visible in list, photo removed from storage only on hard-delete later)

---

### S4 — Tags + Ratings + Search

**Scope:** Ratings (1–5 stars per user per recipe), rich filter UI with volltext + tag + min-rating + max-prep-time, "Zufall" picker, custom tag creation UI.

**Deliverables:**

**Domain:**
- `Rating { Id, RecipeId, UserId, Stars (1–5), Comment?, CreatedAt, UpdatedAt }` — unique (RecipeId, UserId)

**Infrastructure:**
- Migration `AddRatings`
- Postgres full-text search setup: `tsvector` column on Recipe (computed from title + description + ingredient names + notes), GIN index, German text search config (`german`)

**API:**
- `POST /recipes/:id/ratings` — upsert current user's rating (create or update). Body `{ stars, comment? }`.
- `DELETE /recipes/:id/ratings` — removes current user's rating.
- `GET /recipes/:id/ratings` — returns list + aggregate (avg, count).
- `GET /groups/:groupId/recipes/search` — query params:
  - `q` — full-text query (optional)
  - `tags` — comma-separated tag IDs (optional)
  - `minRating` — decimal (optional, uses avg)
  - `maxPrepTime` — int minutes (optional)
  - `createdBy` — user ID (optional)
  - `sort` — `newest|best_rated|last_cooked` (default: `newest`)
  - `page`, `pageSize`
- `GET /groups/:groupId/recipes/random` — same filter params, returns 1 random match.
- `POST /groups/:groupId/tags` — create custom tag in group scope.
- `GET /groups/:groupId/tags` — returns global + group-scoped tags.
- `DELETE /groups/:groupId/tags/:tagId` — admin-only, only custom tags.

**Web:**
- Rating widget on recipe detail: stars input + comment textarea + submit/update/clear
- Filter sidebar on recipe list:
  - Text search input (debounced)
  - Tag multi-select (chips by category)
  - Rating min slider (1–5 stars)
  - Prep-time max slider
  - Creator dropdown
  - Sort dropdown
- "Zufall" button → fetches random → navigates to recipe detail
- Tag management panel (admins, per group): create custom, delete custom
- Filter state persisted in URL query params

**Tests (TDD):**

Domain:
- Rating stars 1..5 inclusive
- Unique per user per recipe (second attempt = update)

Infrastructure:
- Full-text search finds partial matches in title + ingredients
- Filter combination logic (AND across filter types)

API:
- Rate recipe → aggregate reflects; re-rate same recipe → aggregate stable at 1 count
- Search with multi-tag filters returns only recipes having all tags (configurable; PRD says "with these tags" = AND)
- Random respects filters (seed test: all filtered recipes have tag X → random always has X)

Web:
- Filter UI updates URL
- Rating widget reflects current user's rating
- Random button navigates

**Acceptance:**

- [ ] User can filter recipes by 3 criteria simultaneously
- [ ] Random picker respects active filters
- [ ] Rating persistence + aggregation work correctly

---

### S5 — Portions + Fork + Group Defaults

**Scope:** Live portion scaling on recipe detail, group-level default_servings, fork recipe to another group.

**Deliverables:**

**Domain:** (already has `Group.DefaultServings`, `Recipe.ForkOfRecipeId`, `Ingredient.Scalable`, `Ingredient.Quantity`)

**Infrastructure:**
- `IngredientScaler` utility: scales a list of ingredients to target servings, respecting `Scalable` flag and unit-aware rounding:
  - Stück-like units (Stück, Scheiben, Eier, Knoblauchzehen, …): round to nearest whole, badge "~" if adjusted
  - Decimal units (g, ml, EL, TL): round to 2 decimals
  - Unscalable: pass through untouched
- Unit list shared with frontend via `@familien-kochbuch/shared`

**API:**
- `POST /recipes/:id/fork` — body: `{ targetGroupId }` — creates independent copy in target group, preserves `ForkOfRecipeId`. User must be member of target group. Copies ingredients, steps, tags (global tags kept; group-scoped tags: best-effort match in target group, else dropped with note).
- `PUT /groups/:id/settings` — already covered in S2 for default_servings, but now also: cover image upload endpoint.

**Web:**
- Recipe detail: portion-slider component (number input + ±) above ingredients
  - Changing value re-renders ingredient list with scaled quantities (client-side computation using shared utility)
  - "Für {Gruppen-Name} umrechnen (X Portionen)"-button sets slider to group default
- "In andere Gruppe kopieren"-button on recipe detail:
  - Dialog: pick target group, confirm
  - After fork: navigate to new recipe
- Fork banner on recipe detail: "Dieses Rezept wurde aus [Link zu Original] geforkt." (shown when ForkOfRecipeId is set)

**Tests (TDD):**

Utility (`IngredientScaler`):
- 500 g at 4 → 250 g at 2 → 500 g at 4 roundtrip
- 3 Eier at 4 → 1.5 at 2 → displays as "2 Eier (~1.5)" (or equivalent UX decision — test the pure math here)
- Scalable=false → unchanged
- quantity=null → unchanged (nach Geschmack)

Domain:
- Fork copies fields, preserves ForkOfRecipeId

API:
- Fork into group where user is not member → 403
- Fork preserves global tags
- Fork to same group allowed (creates independent copy) but UI shouldn't offer (frontend decision)

Web:
- Slider updates quantities live
- Group-default button prefills slider
- Fork dialog flow

**Acceptance:**

- [ ] Slider on Bacon-Cheeseburger test recipe (if we import one) scales live
- [ ] Fork into second group creates independent copy; editing original doesn't touch fork

---

### S6 — Version History (light)

**Scope:** Track last 5 revisions per recipe, viewable diff. Minimal, pragmatic.

**Deliverables:**

**Domain:**
- `RecipeRevision { Id, RecipeId, ChangedByUserId, ChangeType (Created|Edited|Forked), SnapshotJson (string, full recipe serialized), CreatedAt }`

**Infrastructure:**
- Migration `AddRecipeRevisions`
- On Recipe create / update / fork: persist revision with serialized snapshot
- Pruning: after insert, delete revisions beyond the 5 most recent for that recipe (transactional or scheduled, fine either way)

**API:**
- `GET /recipes/:id/revisions` — list (id, changedBy, changeType, createdAt, short summary)
- `GET /recipes/:id/revisions/:revId` — full snapshot for diffing

**Web:**
- Recipe detail: "Historie"-panel (expandable), lists 5 revisions with timestamp + user
- Click revision → modal with side-by-side-ish diff (title, ingredients list, steps list) between selected revision and current — implementation: simple deep-compare rendering, not a full text diff library

**Tests (TDD):**

Infrastructure:
- Save revision on update → RecipeRevisions row inserted with serialized snapshot
- 6th revision prunes oldest
- Snapshot deserializes back to equivalent structure

API:
- GET returns last 5

Web:
- Panel renders
- Diff modal shows differences

**Acceptance:**

- [ ] Edit a recipe 6 times, only 5 revisions retained (oldest dropped)
- [ ] Diff shows clear visual difference

---

### S7 — Polish & Local Deploy Readiness

**Scope:** Full-stack smoke test, PWA service worker, proper error boundaries, final docs, production docker-compose.

**Deliverables:**

- `docker-compose.prod.yml` — image-based, expects `ghcr.io/kay-solutions/familien-kochbuch-{api,web}:latest`
- `.github/workflows/deploy.yml` — builds images on push to main, pushes to GHCR; SSH step is scaffolded but commented out (no server yet)
- Web: PWA service worker registered (VitePWA), offline fallback for recipe detail view
- Web: global error boundary with friendly German message
- Web: loading states (Skeleton) on all async UI
- Backend: structured error response format: `{ code, message, details? }` across all endpoints
- Backend: Swagger/OpenAPI endpoint at `/api/swagger` (dev only)
- End-to-end smoke test script (`scripts/smoke-test.sh`):
  - signs up via seeded admin invite
  - creates group
  - invites a second test user (seeded)
  - creates a recipe with 5 ingredients, 3 steps, 2 tags
  - rates it
  - searches for it
  - forks to second group
  - verifies fork
- `README.md` expanded: troubleshooting, prod deployment section (even if server not live yet)
- Final `docs/phase-1-progress.md` update: all 8 slices `done`

**Tests:**
- All previous slice tests green
- Smoke test passes end-to-end

**Acceptance:**

- [ ] `docker compose up` serves the complete app
- [ ] Smoke test passes
- [ ] No known broken paths in the happy flow

---

## Review Protocol

After each slice's implementation agent reports done:

**Dispatch a review agent** (`feature-dev:code-reviewer` or `superpowers:code-reviewer`) with task:

> "Review the commits on `main` since hash X (start of slice Y). Verify:
> 1. Tests written BEFORE implementation (commit order)
> 2. All tests green (`dotnet test` + `pnpm test`)
> 3. Conventions match hoppr reference (endpoint mapping pattern, test utilities, migration review)
> 4. Security: no obvious XSS/SQLi/auth bypass
> 5. No scope creep beyond the slice spec
> 6. Progress tracker updated
>
> Report: pass / fix-needed. If fix-needed, list specific items."

On fix-needed: dispatch a fix agent with the review's findings, then re-review.
On pass: mark slice `done` in `phase-1-progress.md` and proceed to next slice.

---

## Orchestrator Heartbeat Loop

Every ~270s (close to user's requested 5 min, stays in prompt cache):

1. Read `docs/phase-1-progress.md`.
2. Check if any background sub-agent is currently running (tracked by progress file).
3. Determine next action:
   - Agent running → sleep another cycle
   - Slice done, not reviewed → dispatch review
   - Review passed → dispatch next slice
   - Review failed → dispatch fix
   - All slices done with green reviews → STOP loop, notify user
   - Blocker / design question → pause loop, notify user
4. Update progress file with any state changes.
5. ScheduleWakeup(~270s).

**Stop conditions:**
- All 8 slices done, all reviews green, final smoke test passes → **success stop**
- Blocker requiring user decision → **pause, notify user**
- 3 consecutive fix-needed cycles on same slice → **pause, notify user** (prevents infinite loops)

---

## Notes on Deviations from PRD

Deviations discovered during implementation should be logged inline in `docs/decisions/` as ADR-light, and flagged in the progress tracker. **Non-trivial deviations require pausing the loop for user input.** Examples of trivial: library choice for date picker. Examples of non-trivial: dropping a feature, changing auth model, switching database.
