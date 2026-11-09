# Accounts

Added 2026-10-16 (migration `050_user_accounts.sql`). Before this the platform
had one sign-in and every row was that person's.

## 1. Who owns what

- **The admin** is a fixed account (`00000000-0000-4000-8000-000000000001`).
  It signs in with `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` from the server
  environment, exactly as before, and owns every row that existed before 050.
  Its password is changed in the environment, not in the app. It cannot be
  deleted.
- **Users** sign up with email + password, or with Google. Each user's alerts,
  watchlists, chart layouts, drawings, pane studies, Pine scripts and push
  devices carry `user_id`; every repository query is scoped by it, and the
  owner always comes from the session (`userIdOf(req)` in
  `platform/backend/src/security/requestUser.ts`), never from a request body.
- The shipped Pine **library** rows have no owner and are visible to everyone;
  only the admin may edit them in place.
- Alert uniqueness is per user: every `ma_alerts_*` unique index and every
  `CONFLICT_TARGET` begins with `user_id`, so one user's upsert can never
  update another user's identical alert.
- An alert notifies its owner's devices only (`sendPush(…, { userId })`).
- Deleting an account deletes everything it owns (`ON DELETE CASCADE`), except
  that an account with a package membership can't be deleted: the membership and
  its append-only ledger must be kept, so `DELETE /api/auth/account` answers 409
  and nothing is deleted.

## 2. What an ordinary account may reach

Default-deny. `userMayReach` in `platform/backend/src/security/requestUser.ts`
lists the user routes: the chart and its data, their own things, the
screener (read + pattern analysis) and the Shariah screen (read-only).
Trading, deployments/webhooks, operations, research, optimizer, stress,
journal, execution and scanner configuration are admin-only — they act on the
owner's exchange account. A route added later is admin-only until listed.
The frontend mirrors this (`ADMIN_ONLY_HREFS` in `platform/frontend/lib/navigation.ts`,
and the API client refuses admin-only endpoints for a known ordinary account),
but the backend is what enforces it. Since 2026-11-01 the chart workstation
also hides, for a KNOWN ordinary account, the *Positions & Orders* and
*Strategy Tester* tabs, the Trade button and the Automate / Strategy / Best
config controls, and does not poll the manual-trading state
(`platform/frontend/tests/dom/chartRoleTabs.test.tsx`). Typing the URL of an
administrator page (`/trading`, `/journal`, `/bot`, `/research`, `/stress`,
`/optimizers`, `/operations`) as a known ordinary account shows a short notice
and a link to the chart instead of the page (`components/AdminOnlyPage.tsx`,
`tests/dom/adminOnlyPages.test.tsx`); the Shariah screen is read-only for such
an account, with every write control and the first-person operator copy
removed (`tests/dom/shariahReadOnly.test.tsx`); the Profile page states what a
Standard account provides.

What an ordinary account may do with market history is bounded
(`platform/backend/src/api/routes/data.ts`, added 2026-11-01): a backfill or
coverage request is clamped to the newest 200,000 source bars — the same amount
the candles read serves — and the response says so (`clamped`, `coveredFrom`,
`note`). Requests over 20,000 source bars count as heavy, including deep candle
reads and Pine runs: at most two per account and four across all ordinary
accounts run at once (`platform/backend/src/api/historyAdmission.ts`), which bounds
their memory however many accounts sign up. Beyond that the server answers 429
and the browser waits its turn for up to 90 seconds before reporting it;
requests under the threshold, such as a chart's default depth and tail repairs,
take no slot.
a Pine run (`POST /api/pine/run`) that would read more than 200,000 source bars
including warm-up is refused with a sentence naming the limit. The admin is not
bounded; an admin backfill deeper than that streams through `backfillRange` in
bounded memory. Registering a symbol (`POST /api/symbols`,
or implicitly through a backfill) never trusts caller-supplied assets and never
writes a pair the venue does not list (404 instead); a suffix-guessed row is
written only when the exchange directory is unreachable and the quote asset
is recognisable (otherwise 503), and `POST /api/symbols` marks such a row
`degraded` in its response.

## 3. Sessions

Cookie `srtrend_session` = `u2.<userId>.<sessionVersion>.<expiry>.<hmac>`
(90 days, sliding). "Sign out everywhere" and a password change bump
`users.session_version`, ending every other session. A password change is
compare-and-set: it applies only if the account is still at the session version
the request was signed in under and still has the password it checked, so one
that a reclaim or a sign-out-everywhere overtook gets 401 and no session. An
old-format admin cookie is accepted once and re-issued in the new format.

## 4. Google sign-in

OIDC authorization-code flow with PKCE (`platform/backend/src/security/google.ts`).
Configured by three environment variables on the app server
(`platform/deployment/aws/compose.app.yml` passes them through):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the OAuth client id |
| `GOOGLE_CLIENT_SECRET` | the OAuth client secret (never commit it) |
| `PUBLIC_BASE_URL` | `https://mytradingview.alphawebstudioz.com` |
| `ALLOW_SIGNUPS` | `true` (default) / `false` to close sign-ups |

Authorized redirect URI in Google Cloud: `<PUBLIC_BASE_URL>/api/auth/google/callback`.
The button appears only when all three are set.

A Google sign-in whose verified email matches an existing account whose email
is NOT verified takes that account back for the Google user, and removes
everything its registrant set up, the password included (emails are not
verified at password sign-up, so this defeats account pre-hijacking; see
"Joining by email" in §7). An account whose email is verified is joined and keeps
everything. Google is never joined to the admin by email — the admin links it
from Profile while signed in.

## 5. Pages

`/login` (sign in / create account, `?mode=signup`, `/signup`, the two-factor
step), `/verify-email` (where an emailed link lands), `/onboarding` (name + starter
watchlist), `/profile` (name, password, email verification, Google and GitHub links,
two-factor sign-in, recent sign-ins, sign out everywhere, delete account). Browser storage is cleared when a different
account signs in on the same browser.

## 6. Tests

`platform/backend/tests/accountSecurityDb.test.ts` (verification, two-factor and
GitHub through the real API and PostgreSQL), `platform/backend/tests/accountProviderLinkDb.test.ts`
(taking back an unverified account, linking from the profile, replayed round trips and
the compare-and-set password change), `platform/backend/tests/twoFactor.test.ts`
(RFC 6238 vectors), `platform/frontend/tests/dom/accountSecurity.test.tsx`,
`platform/backend/tests/accounts.test.ts` (tokens, reach, Google token checks),
`platform/backend/tests/accountsDb.test.ts` (two accounts, real API, own
database — nothing of one is visible to or changeable by the other),
`platform/frontend/tests/dom/accountPages.test.tsx`.

## 7. Email verification, two-factor sign-in and GitHub

Added 2026-11-05 (migration `052_account_security.sql`). `/api/auth/me` reports
`moneyFeaturesUnlocked` when an account has both a verified email and two-factor on.
Joining a package cohort requires both (`platform/backend/src/api/routes/packages.ts`);
linking a provider from the profile requires a verified email (see below). The
administrator counts as verified, because it has no email.

**Email verification.** Signing up sends a link that works once and expires in 24
hours. Only its hash is stored, and a new link replaces the old one. A provider's
verified address counts as verified. If sending fails, the account is still created
and can ask again from its profile. Opening `/verify-email` uses nothing: the token
is sent, with a POST, only when the person presses "Confirm my email address", and the
page says to confirm only an account they created. Mail scanners and link previewers
open links, and some run the page's script, so a page that verified on load would let
one of them verify an account for whoever registered the address.

**Two-factor sign-in.** Standard TOTP from an authenticator app, in
`platform/backend/src/security/twoFactor.ts`.

- Setup needs a verified email and the account's password, so someone holding an
  unverified address or a stolen session can't lock out the owner. The secret is
  encrypted with `ALERT_ENCRYPTION_KEY`.
- A correct password or provider sign-in then gives a 5-minute proof cookie, not a
  session. The code or a recovery code turns it into a session.
- Each code works once. Guesses are limited to 5 per 5 minutes per account.
- Ten recovery codes are shown once and stored hashed.
- Turning it off needs the password and a code, and ends every other session.

**Joining by email.** If an unverified account's address signs in through Google or
GitHub, the provider has proved who owns it, and the account is taken back for that
person in case someone else registered it first. In one transaction, with the account
row locked: the password, the two-factor secret and recovery codes, BOTH provider links
(a squatter may have linked their own Google or GitHub), push devices and any
outstanding verification links are removed, the avatar becomes the provider's picture,
every session ends, the email counts as verified, and the provider in use is linked. If that provider id turns out to be on
another account, nothing changes and the sign-in fails with "already linked". A
verified account keeps its password, its other links and its two-factor setup, and
must still pass its second factor.

**Linking Google or GitHub from the profile.** The round trip is bound to the session
that started it: the callback links only for that same signed-in account at the same
session version, so a link started before a sign-out-everywhere, a password change or
a reclaim does nothing. Each round trip works once. Linking needs a verified email (the
administrator counts as verified); an unverified account may link only a Google or
GitHub account whose verified email is its own address, which then verifies it.
Otherwise the browser returns to `/login` with a message saying so, and the profile
says it beside the link buttons. Linking is not a sign-in: it issues no new session and
records no sign-in, and the current session carries on.

**GitHub.** OAuth with PKCE in `platform/backend/src/security/github.ts`. It only accepts
a primary, verified address, and a GitHub account without one is refused.

**Sign-in history.** The newest 50 sign-ins per account, with method, address and browser,
shown on the profile. Deleting an account deletes them.

**Locked out of the administrator account.** Use a recovery code. If those are lost too,
someone with database access must clear `totp_secret_enc` and `totp_enabled_at` on the
admin row. There is no way to do this from the app.

### Not built

Password reset by email and changing an account's email address. Failed sign-ins aren't
recorded in the history. Rate limits are per process, as `security/rateLimit.ts` states.

### Turning it on in production

Everything stays off until these are set in `/opt/srtrend/deployment/.env`:

1. **Email.** Verify the sending domain in Amazon SES (`ap-south-1`) and add its DNS
   records in Hostinger. Request production access, because until then SES only delivers
   to verified addresses. Set `EMAIL_FROM`, for example `no-reply@alphawebstudioz.com`.
2. **Email permission.** Allow `ses:SendEmail` for that identity on the instance role.
   Containers may not be able to reach that role, depending on the instance's metadata
   hop limit. If sending fails with a credentials error, don't raise the hop limit, which
   would give every container the role. Create an IAM user limited to `ses:SendEmail`,
   and set `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY`.
3. **GitHub.** Create an OAuth App with the callback
   `<PUBLIC_BASE_URL>/api/auth/github/callback`, and set `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`.
4. **Deploy check.** Production has migrations this repository doesn't ship
   ([OPERATIONS §10](OPERATIONS.md)), so check the dry run applies `052` cleanly.

## When the session cannot be read

A failed `/api/auth/me` read offers nothing of the administrator's, because the
account is not known. It retries by itself (after 2, 5, 15, then every 30
seconds, and at once when the browser comes back online), and the chart says why
its trading controls are hidden (`SessionCheckBanner`).
