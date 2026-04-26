# Third-party notices

`shared-cookbook` is licensed under the [MIT License](LICENSE). It
ships and runs alongside a number of third-party open-source
components, each under its own license. This file lists the
non-trivial ones and the obligations they carry, plus the broader
license tally for transparency.

Nothing in this file overrides the upstream package's own license
text — when in doubt, consult the upstream `LICENSE` file shipped
inside the corresponding NuGet package, npm tarball, Python wheel,
or Docker image.

---

## Components that need explicit attention

### Hangfire (`Hangfire.AspNetCore`, `Hangfire.PostgreSql`, `Hangfire.Core`)

License: **LGPL v3** (the OSS pieces; Hangfire.Pro is commercial and
is not used here).

What this means for `shared-cookbook`:

- We **link against** Hangfire as a managed-assembly dependency. LGPL
  v3 explicitly permits this without requiring `shared-cookbook`
  itself to be relicensed.
- Recipients must be able to swap in a modified Hangfire build. With
  .NET assemblies that is satisfied trivially: drop a different
  `Hangfire.*.dll` into the deploy directory.
- Source for Hangfire is openly available at
  https://github.com/HangfireIO/Hangfire (and the matching repos for
  `Hangfire.PostgreSql`). We make no modifications.

If you fork `shared-cookbook` and start modifying Hangfire itself,
your modifications must be released under LGPL v3.

### Redis 7.4+ (Docker image `redis:7-alpine`)

License: **Redis Source Available License v2 (RSALv2)** /
**Server Side Public License (SSPL)** — Redis Inc. relicensed away
from BSD with Redis 7.4 in March 2024. The `redis:7-alpine` tag
resolves to that line.

What this means for `shared-cookbook`:

- **Self-hosting `shared-cookbook` is fine.** RSALv2 only restricts
  offering Redis itself "as a service" to third parties. Embedding
  it as an internal cache for your own application is explicitly
  allowed.
- **If you fork `shared-cookbook` and offer it as a managed,
  multi-tenant SaaS**, you may trip the RSALv2 / SSPL boundary
  because the bundled Redis would then be part of a service offering.
  In that case, replace `redis:7-alpine` with a community fork
  ([Valkey](https://valkey.io/) or [KeyDB](https://docs.keydb.dev/))
  before shipping.

For all single-family / personal-VPS / on-prem use, no action needed.

### `caniuse-lite` (transitive npm dep)

License: **CC-BY-4.0**.

This is a build-time data package consumed by `browserslist`. The
data does not ship in our distributed `dist/` bundle, so the CC-BY
attribution requirement does not propagate to runtime users. We
acknowledge it here for completeness.

---

## Broad license tally

### Web (`apps/web` + `packages/shared`, npm production tree)

Generated via `pnpm licenses list -P --recursive`:

| License        | Count |
| -------------- | ----- |
| MIT            | 508   |
| Apache-2.0     | 27    |
| ISC            | 25    |
| BSD-2-Clause   | 11    |
| BlueOak-1.0.0  | 8     |
| BSD-3-Clause   | 6     |
| OFL-1.1 (fonts)| 3     |
| MPL-2.0        | 2     |
| MIT-0          | 2     |
| Unlicense      | 1     |
| CC0-1.0        | 1     |
| CC-BY-4.0      | 1     |

All permissive. MPL-2.0 is file-level copyleft and only triggers if
the MPL source files (`lightningcss*` here) are themselves modified
— we do not. OFL-1.1 fonts are bundled as `.woff2` and the license
explicitly permits that.

### .NET (`apps/api`, runtime dependencies)

| Package family                                  | License         |
| ----------------------------------------------- | --------------- |
| `Microsoft.*` (.NET runtime, EF Core, Identity) | MIT             |
| `Npgsql.EntityFrameworkCore.PostgreSQL`         | PostgreSQL Lic. |
| `System.IdentityModel.Tokens.Jwt`               | MIT             |
| `Konscious.Security.Cryptography.Argon2`        | MIT             |
| `MailKit`                                       | MIT             |
| `FluentValidation`                              | Apache-2.0      |
| `Serilog.AspNetCore`                            | Apache-2.0      |
| `Swashbuckle.AspNetCore`                        | MIT             |
| `Hangfire.AspNetCore`, `Hangfire.PostgreSql`    | **LGPL v3**     |

### Python (`apps/python-extractor`)

| Package                                     | License             |
| ------------------------------------------- | ------------------- |
| `fastapi`, `pydantic`, `pydantic-settings`  | MIT                 |
| `uvicorn`, `httpx`, `tenacity`              | BSD-3 / MIT         |
| `ruff`, `mypy`                              | MIT                 |
| `respx`, `pytest`, `pytest-asyncio`         | MIT                 |
| `jsonschema`                                | MIT                 |
| `extruct`, `recipe-scrapers`                | BSD-3 / MIT         |
| `beautifulsoup4`, `lxml`                    | MIT / BSD           |
| `yt-dlp`                                    | Unlicense (PD)      |
| `faster-whisper`, `ctranslate2`             | MIT                 |
| `whisper-large-v3` model weights (HF cache) | MIT (OpenAI)        |

### Docker base + sidecar images

| Image                                         | License            |
| --------------------------------------------- | ------------------ |
| `mcr.microsoft.com/dotnet/{sdk,aspnet}:10.0`  | MIT                |
| `node:22-alpine`                              | MIT (Node) + Alpine|
| `python:3.13-slim`                            | PSF (Python)       |
| `postgres:17-alpine`                          | PostgreSQL License |
| `redis:7-alpine`                              | **RSALv2 / SSPL** (see above) |
| `caddy:2-alpine`                              | Apache-2.0         |
| `chrislusf/seaweedfs:4.21`                    | Apache-2.0         |
| `ollama/ollama:0.21.2` (optional)             | MIT                |

---

## How to regenerate / verify

```bash
# npm tree (production scope)
pnpm licenses list -P --recursive

# .NET runtime tree
dotnet list apps/api/src/SharedCookbook.Api/SharedCookbook.Api.csproj package

# Python tree (each package's own metadata)
cd apps/python-extractor && uv run pip show <package>
```

For Docker images, the upstream repository on Docker Hub or GHCR is
the authoritative source.

---

## Reporting an issue

If you believe a third-party component is misattributed here, open
an issue: https://github.com/dKaulig/shared-cookbook/issues
