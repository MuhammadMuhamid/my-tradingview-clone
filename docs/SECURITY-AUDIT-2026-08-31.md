# Security and QA audit — 2026-08-31

**Status:** current. A separate audit from the 2026-08-23 register recorded in
[REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md), which is generated from
`scripts/ledger/findings.json` and covers 154 findings with a "each identifier
appears exactly once" invariant. These findings are **not** added to that
register: they were not found by that audit, and back-filling them would
misrepresent what it reported. This file is the record for this one.

Scope: the whole clone — backend, frontend, deployment scripts, dependencies —
plus the live AWS estate.

---

## 1. Fixed

### SSRF in `POST /api/push/subscribe`

A Web Push subscription endpoint is a URL this server later POSTs to, and the
route accepted any URL that parsed. Anything able to reach it — including an
XSS or a stolen session — could aim deliveries at `169.254.169.254` or a host
inside the VPC and use the push fan-out as a proxy.

`validatePushEndpoint` now applies the same rule the webhook sender has always
applied: HTTPS, port 443, no embedded credentials, and a host on an allowlist.
Unlike webhook hosts these are fixed by the browser vendors, so the list is in
code rather than in the environment.

The check runs **again at send time**, not only at subscribe time: rows written
before the rule existed are still in the table, and send time is the last point
before an outbound request is actually made.

Covered by `platform/backend/tests/pushBoundaries.test.ts`, including lookalike hosts such as
`evil-push.apple.com.attacker.test`.

### The security test suite was not hermetic

`platform/backend/tests/security.test.ts` asserts that a missing `ALLOWED_WEBHOOK_HOSTS` refuses
to boot. It spawns a child process with a controlled environment — but
`config.ts` imports `dotenv/config`, so the child read the developer's real
`backend/.env` and quietly satisfied the very variables the test asserted were
absent. The suite therefore passed or failed depending on whether the machine
had a `.env`.

`DOTENV_CONFIG_PATH` now points at a path that cannot exist, so the child sees
exactly the environment the helper passes it. This had been dismissed as a
local quirk for some time; it was a real isolation defect.

### The backend verify gate was red

An unused `PivotType` import failed `npm run lint`, and had done since the
pivot-alerts commit — meaning `npm run verify` did not pass on `main`.

### Unbounded credential copies on the app instance

`update-app.sh` wrote a timestamped `.env.bak-*` on every deploy and never
pruned them. Twenty-two had accumulated, each a full copy of the live
`DATABASE_URL`, `ALERT_ENCRYPTION_KEY`, `SESSION_SECRET` and admin password
hash. One is what a rollback needs; the rest were extra copies to steal. The
script now keeps the five most recent, and the first deploy after the change
reduced the box from 22 to 5.

---

## 2. Corrections to earlier statements

Recorded because both were stated with more confidence than the evidence
supported.

**`/opt/srtrend/admin-password.txt` is `-rw-------`, root-only.** It was
described as "sitting in plaintext" in a way that implied exposure. It is a
credential at rest with correct permissions — worth removing eventually, not
the finding it was made to sound like.

**The 2026-08-27 database outage was not a compromise.** An RDS "Reset master
credentials" event followed by KMS access failures looked like it warranted
investigation. CloudTrail settles it: all four `RetireGrant` calls came from
`AWSService` / `rds.amazonaws.com` ("AWS Internal") with no IAM principal and
no external source IP, and there were **zero** `StopDBInstance`,
`ModifyDBInstance` or `CreateGrant` events in the window. RDS retired its own
KMS grants and stopped itself. Entirely AWS-side.

---

## 3. Examined and clean

| Area | Finding |
|---|---|
| SQL injection | None. Every identifier interpolated into SQL is a code literal from a fixed set; every value is parameterised. Checked across all repositories. |
| Untrusted code execution | The Pine engine is a real lexer/parser/interpreter — no `eval`, no `new Function` — run in a worker thread under a wall-clock budget and a heap cap, terminated when either is exceeded. |
| XSS | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` anywhere in the frontend, asserted by `platform/frontend/tests/noUnsafeSinks.test.ts`. That test is the actual control, because the CSP needs `'unsafe-inline'` for Next's bootstrap. |
| Open redirect | `?next=` is decoded before judgement and must be a same-origin absolute path (`platform/frontend/lib/safeRedirect.ts`). |
| Authentication | HMAC-signed HttpOnly cookie; a token is valid only for the currently configured username. Sign-in is rate-limited because each attempt costs ~100 ms of scrypt on the live runner's event loop. |
| Authorisation | One `onRequest` hook guards every route, so a new endpoint is protected by omission rather than by remembering. `PUBLIC_PATHS` is the entire exception list. |
| Configuration | Fails closed on a missing password hash, a short or placeholder session secret, a weak encryption key, or an empty webhook allowlist. |
| Secrets at rest | AES-256-GCM for webhook secrets and bot uuids; outbound payloads and receiver response bodies redacted before storage. |
| Live-order endpoint | Five independent guards: env flag (default off), confirmation phrase, paused deployment, custom delivery only, and a $20 ceiling. |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities, backend and frontend. |

---

## 4. Accepted, not fixed

- **Sessions cannot be revoked before expiry.** They are stateless HMAC tokens
  with a 90-day sliding window and no session store. Acceptable for a
  single-admin application; changing the configured username invalidates every
  outstanding token, which is the available lever.
- **Only sign-in is rate-limited.** An authenticated operator can still make
  expensive requests. The Pine budget caps the worst of it.
- **The CSP cannot forbid inline script** without giving up static
  prerendering. The no-unsafe-sinks test is the compensating control.
- **Five ESLint hook-dependency warnings** in `CandleChart` and friends are
  false positives: those callbacks read from refs deliberately, to avoid
  re-subscribing chart handlers. Changing them adds regression risk for no
  behavioural gain.
- **A pre-existing React duplicate-key warning** (`key "2"`) appears in dev
  mode on pages unrelated to any recent change, including `/optimizers`. Not
  investigated; recorded so the next person does not assume it is new.

---

## 5. Reducing AWS cost

Asked for alongside the audit. The honest answer runs opposite to the question:
the estate is **under-provisioned**, not over-provisioned, and the same day
proved it twice.

| Action | Saving | Note |
|---|---|---|
| Move image builds to CI (GitHub Actions → ECR, box only pulls) | none directly | Removes the memory ceiling from the deploy path. A `t3.micro` cannot build the frontend image in place; doing so caused a production outage. |
| CloudWatch alarm on RDS status | none | Would have caught the 2026-08-27 database stop on day one instead of day four. Four days of silent downtime costs more than the instance. |
| 1-year Savings Plan on the two EC2 instances and RDS | ~30–40% | The only genuine reduction available at this size. Same hardware. |
| Downsizing further | — | **Do not.** Already at the smallest usable tier. |
| Dropping RDS backups | — | **Do not.** The 2026-08-26 snapshot was the safety net during the outage. |
