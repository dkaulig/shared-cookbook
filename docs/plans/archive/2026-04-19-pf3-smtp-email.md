# PF3 — SMTP Email Sender (Password-Reset + Group-Invites + App-Invites)

**Slice:** PF3
**Status:** planned
**Date:** 2026-04-19
**Depends on:** Phase 1 (password-reset flow, invite endpoints) complete.
**User request:** 2026-04-19 — "email versand eigentlich eingebaut? … auch group invites usw".

## Why

Infra is half-built. `IEmailSender` interface + `NoOpEmailSender` (logger only) exist. `docker-compose.prod.yml` already passes `Smtp__Host` / `Smtp__Port` / `Smtp__User` / `Smtp__Password` / `Smtp__FromAddress` / `Smtp__FromName` env vars to the api container — and those env vars are set in `PROD_ENV` on GitHub as of 2026-04-18 — but **nothing reads them**. Password-reset emails are logged to stdout, never sent.

Three flows need real emails:

1. **Password reset** — `POST /api/auth/password-reset-request` currently calls `IEmailSender.SendPasswordResetAsync` which no-ops.
2. **App invites** (signup links, `AppInvite` entity) — `POST /api/invites/app` currently generates a link but doesn't deliver it. Admin has to copy-paste manually.
3. **Group invites** (`GroupInvite` entity) — invited user sees the invite in the app if they log in, but no notification email. For family/friends who aren't in the app yet this is the primary reach path.

## Scope

### 1. `MailKit` dependency + `SmtpOptions`

- Add `MailKit` (MIT, maintained, standard-in-modern-.NET) to `FamilienKochbuch.Infrastructure.csproj`.
- New `SmtpOptions.cs` in `FamilienKochbuch.Api/Services/` following the existing `*Options` pattern:
  ```csharp
  public sealed class SmtpOptions
  {
      public const string SectionName = "Smtp";
      public string Host { get; init; } = "";
      public int Port { get; init; } = 587;
      public string User { get; init; } = "";
      public string Password { get; init; } = "";
      public string FromAddress { get; init; } = "";
      public string FromName { get; init; } = "Familien-Kochbuch";
      public bool UseStartTls { get; init; } = true; // Posteo/Migadu/most EU providers
  }
  ```

### 2. `SmtpEmailSender` implementation

- New `SmtpEmailSender : IEmailSender` in `FamilienKochbuch.Infrastructure/Services/`.
- Uses `MailKit.Net.Smtp.SmtpClient` with the configured host/port + `StartTls` + auth.
- Connection per send (stateless); no pooling for v1.
- `Sender = new MailboxAddress(FromName, FromAddress)`, `To = <recipient>`.
- Plain-text body for v1 (no HTML templates yet — HTML polish = Phase 3).
- Logs subject + recipient at INFO, never the body content.
- Timeout: 30s. On failure: throws `EmailSendException` which the caller logs; the user-facing endpoint does NOT error out (password-reset + invite-create should still succeed even if the mail delivery fails — the backend has the data, manual copy-paste is a fallback).

### 3. `IEmailSender` interface extension

Currently has only `SendPasswordResetAsync`. Extend:

```csharp
public interface IEmailSender
{
    Task SendPasswordResetAsync(
        string toEmail, string displayName, string resetUrl, CancellationToken ct = default);

    // PF3 additions:
    Task SendAppInviteAsync(
        string toEmail, string inviterDisplayName, string acceptUrl,
        string? personalNote, CancellationToken ct = default);

    Task SendGroupInviteAsync(
        string toEmail, string inviterDisplayName, string groupName,
        string acceptUrl, CancellationToken ct = default);
}
```

`NoOpEmailSender` stays (dev/test) — extends to log all three shapes.

### 4. Registration logic in `Program.cs`

```csharp
var smtp = builder.Configuration.GetSection(SmtpOptions.SectionName).Get<SmtpOptions>()
           ?? new SmtpOptions();
if (!string.IsNullOrWhiteSpace(smtp.Host) && !string.IsNullOrWhiteSpace(smtp.FromAddress))
{
    builder.Services.AddScoped<IEmailSender, SmtpEmailSender>();
}
else
{
    builder.Services.AddScoped<IEmailSender, NoOpEmailSender>();
    // Log a warning at startup so operators notice missing config
}
```

### 5. Wire into existing endpoints

- `POST /api/auth/password-reset-request` → already calls `SendPasswordResetAsync`. No code change here; behavior improves automatically.
- `POST /api/invites/app/*` (or wherever AppInvite create lives) → call `SendAppInviteAsync` after insert. Link shape: `${FrontendBaseUrl}/signup?invite=${token}`.
- `POST /api/groups/{id}/invites` → after creating `GroupInvite`, look up the invited user's email and call `SendGroupInviteAsync`. Link shape: `${FrontendBaseUrl}/groups?invite=${id}` (accept route already exists).

All three call sites guard the mail send with a try/catch so mail failure doesn't bubble up as a 5xx to the user — log + continue. The invite/reset record is authoritative regardless.

### 6. Email templates

Plain text, German, kept in `EmailTemplates.cs` as static strings (for now — no Razor templating). Example shape:

```
Subject: Passwort zurücksetzen — Familien-Kochbuch

Hallo {displayName},

du hast eine Passwort-Zurücksetzung angefordert. Folge diesem Link
(gültig 24 Stunden), um ein neues Passwort zu vergeben:

{resetUrl}

Solltest du diese Anfrage nicht gestellt haben, ignoriere diese E-Mail
einfach — dein aktuelles Passwort bleibt unverändert.

— Familien-Kochbuch
```

Similar text for app-invite + group-invite. All templates in a single file so future HTML polish has one stop.

### 7. Tests

Unit tests (both senders):
- `NoOpEmailSender` logs each of the three methods at INFO.
- `SmtpEmailSender` contract tests — use `netDumbster` (in-process SMTP fake, NuGet MIT-licensed) to:
  - Confirm MIME headers (From, To, Subject, Content-Type text/plain UTF-8).
  - Confirm body contains the expected placeholders substituted.
  - Confirm auth credentials were sent.
  - Confirm connection failure surfaces as `EmailSendException`.

Integration tests:
- `AuthEndpointsTests`: password-reset-request with SmtpEmailSender registered — verify the fake SMTP received one message to the expected address.
- `InviteEndpointsTests` (or wherever app-invite create lives): same flow for app invites.
- `GroupEndpointsTests`: same for group invites.
- One test per endpoint covering: mail-send fails → endpoint still returns 2xx (graceful fallback).

Registration tests:
- Empty SmtpOptions → NoOpEmailSender resolved.
- Populated SmtpOptions → SmtpEmailSender resolved.

### 8. `.env.example`

Already has the SMTP vars documented via comments in `docker-compose.prod.yml`. Mirror the comment block into `.env.example` explicitly so dev-machine users know they can leave them empty:

```
# SMTP — password-reset + invite emails. Leave empty to use the
# NoOp logger-only sender (reset URLs appear in api container logs).
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_ADDRESS=
SMTP_FROM_NAME=Familien-Kochbuch
```

### 9. Docker Compose — add dev passthrough

`docker-compose.yml` currently doesn't pass SMTP vars (prod does). Mirror the six `Smtp__*` env entries in the dev compose so a developer can test against a Mailpit/MailHog container.

Optional: add a `mailpit` service to `docker-compose.yml` (not prod) that listens on 1025/8025 so devs can send test mails and inspect them at `http://localhost:8025`. Acceptable scope creep, small value.

## Non-goals

- No HTML emails (plain text only, Phase 3 polish).
- No i18n / translations (German only for now).
- No DKIM / SPF / domain-reputation setup — operator's responsibility on Posteo / Migadu.
- No queue / retry — if SMTP send fails, log + move on. Phase 3 can add a Hangfire retry if usage warrants.
- No unsubscribe-link infra (these are transactional, not marketing).
- No per-user "email preferences" toggle.

## Acceptance criteria

- All four test suites green + new tests.
- `dotnet test`, `pytest`, `pnpm test`, `pnpm build`, `pnpm lint` all clean.
- With SMTP env vars populated: triggering password-reset against the running stack produces a real mail (dev-smoke via Mailpit).
- With SMTP env vars empty: behaviour falls back to NoOpEmailSender + startup warning.
- Group-invite + app-invite flows now deliver a real email to the invited user.

## Anti-shortcut reminders

- TDD for the new senders + the registration branch.
- No secrets hardcoded — tests use `fake-host`/`fake-user`/`fake-password` constants.
- Never log email body content at INFO (subject + recipient only).
- Mail failures must NOT break the user-facing endpoint — the underlying domain record is the source of truth.
- Graceful fallback path (NoOpEmailSender) kept for tests + dev.

## Dispatch notes

Impl agent work order:
1. `SmtpOptions` + IEmailSender extension + NoOpEmailSender stubs for the two new methods (TDD).
2. `SmtpEmailSender` with `netDumbster`-backed tests.
3. Registration branch in `Program.cs` + test.
4. Wire into password-reset endpoint (behaviour already calls the sender — test only).
5. Wire into app-invite create endpoint + test.
6. Wire into group-invite create endpoint + test.
7. `.env.example` comment block + optional `mailpit` dev service.

Post-impl passes (per user mandate 2026-04-19): `/simplify` → `/security-review` → reviewer-agent, then fix-cycle + tracker update.
