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
- Deleting an account deletes everything it owns (`ON DELETE CASCADE`).

## 2. What an ordinary account may reach

Default-deny. `userMayReach` in `platform/backend/src/security/requestUser.ts`
lists the user routes: the chart and its data, their own things, the
screener (read + pattern analysis) and the Shariah screen (read-only).
Trading, deployments/webhooks, operations, research, optimizer, stress,
journal, execution and scanner configuration are admin-only — they act on the
owner's exchange account. A route added later is admin-only until listed.
The frontend mirrors this (`ADMIN_ONLY_HREFS` in `platform/frontend/lib/navigation.ts`,
and the API client refuses admin-only endpoints for a known ordinary account),
but the backend is what enforces it.

## 3. Sessions

Cookie `srtrend_session` = `u2.<userId>.<sessionVersion>.<expiry>.<hmac>`
(90 days, sliding). "Sign out everywhere" and a password change bump
`users.session_version`, ending every other session. An old-format admin
cookie is accepted once and re-issued in the new format.

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

A Google sign-in whose verified email matches an existing password account
joins it **and removes that password** (emails are not verified at password
sign-up, so this defeats account pre-hijacking). Google is never joined to the
admin by email — the admin links it from Profile while signed in.

## 5. Pages

`/login` (sign in / create account, `?mode=signup`, `/signup`), `/onboarding`
(name + starter watchlist), `/profile` (name, password, Google link, sign out
everywhere, delete account). Browser storage is cleared when a different
account signs in on the same browser.

## 6. Tests

`platform/backend/tests/accounts.test.ts` (tokens, reach, Google token checks),
`platform/backend/tests/accountsDb.test.ts` (two accounts, real API, own
database — nothing of one is visible to or changeable by the other),
`platform/frontend/tests/dom/accountPages.test.tsx`.
