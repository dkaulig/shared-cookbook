# Security Policy

## Reporting a Vulnerability

The preferred channel for reporting a security issue in
open-cookbook is a **GitHub Security Advisory**:

> <https://github.com/kay-solutions/open-cookbook/security/advisories/new>

This link is the official private-disclosure route once the repo
flips to public visibility. Until then the repo is private and the
link resolves to a placeholder — if you already have access to the
private repo, use it anyway; GitHub queues the advisory and
maintainers receive an email.

When filing an advisory, please include:

- A clear summary of the issue and its potential impact.
- Steps to reproduce — commands, request bodies, account setup.
- Affected commit / tag / branch.
- Any proof-of-concept you have (redact real secrets from logs).

We aim to acknowledge reports within **72 hours** and to ship a fix
or publish a coordinated advisory within **30 days** for High /
Critical findings. This is a hobby project maintained by one person,
so please be patient for Low / Informational issues.

## Scope

In-scope for coordinated disclosure:

- `apps/api/` — the .NET Minimal API and its infrastructure layer.
- `apps/web/` — the React SPA, including its service-worker +
  PWA caching.
- `apps/python-extractor/` — the FastAPI extractor service.
- `packages/shared/` — shared TypeScript DTOs.
- `docker-compose.yml` / `docker-compose.prod.yml` — compose
  topology, named volumes, network boundaries.
- `infra/Caddyfile*` — reverse-proxy configuration.
- `.github/workflows/*` — CI / CD pipelines.

Out-of-scope:

- **Third-party dependencies.** Report CVEs in upstream libraries
  (React, .NET SDK, FastAPI, yt-dlp, faster-whisper, Azure OpenAI
  SDKs, etc.) to their own maintainers. If the vulnerability
  manifests through a specific usage pattern unique to this project,
  that IS in scope — prefer a private advisory over a public PR.
- **Self-hosted mis-configuration.** Issues that require an operator
  to deploy with non-default, insecure settings (weak
  `JWT_SIGNING_KEY`, missing `EXTRACTOR_SHARED_SECRET`, public
  Postgres port, etc.) are documentation gaps rather than
  vulnerabilities. PRs against `docs/SETUP.md` are welcome.
- **Denial-of-service that requires authenticated admin.** The
  project is designed for a single family; an admin can already
  reset data.

## Threat model — what we protect against

- **Anonymous internet attackers** scanning a publicly-reachable
  instance for broken auth, SSRF, or injection. See
  `docs/SECURITY-AUDIT-2026-04.md` for the OWASP-Top-10 walkthrough
  performed before the first public release.
- **Authenticated non-admin users** attempting to access other
  users' recipes, meal plans, or groups.
- **Hostile external content** — caption / transcript / blog-HTML
  feeding the AI extraction pipeline. The system prompt wraps
  untrusted sources in `<untrusted_*>` delimiters so the LLM treats
  them as data, not instructions.
- **Cost-amplification** via AI-import endpoints. Per-user rate
  limits blunt runaway-clicks or compromised-account abuse.

## Out-of-scope / accepted risk

- **No 2FA today.** Password + refresh-token rotation + per-user
  lockout is the current stance; WebAuthn is a planned follow-up.
- **No external penetration test.** We do an internal audit per
  major pre-release cleanup. If you've run a pentest and want to
  share results, reach out via a private advisory.
- **No signed container images** (sigstore / cosign) yet. Planned
  for after the first public release.

## Security updates

Fix-commits for reported vulnerabilities land on `main`. Tag releases
(`v*`) pick up the fix; GitHub Security Advisories go public after
the fix is tagged.

## History

See `docs/SECURITY-AUDIT-2026-04.md` for the first-release security
audit. Future audits follow the `SECURITY-AUDIT-YYYY-MM.md`
convention.
