> **Superseded** by [MAHAMID_FINAL_HANDOFF_2026-11-09.md](MAHAMID_FINAL_HANDOFF_2026-11-09.md), the canonical handoff. Read that first.

# Engineering handoff, 2026-11-09: verified fixes and Bot operation inside Trading Scene

**From:** the owner (2ms-muzammil), working with Claude Code.
**To:** Mahamid (MuhammadMuhamid) and his Claude Code.
**Scope:** this campaign's changes to all three repositories, why they were made, how they were verified, and what is still open. Read it once end to end before changing money paths, auth, or the Bot.

---

## START HERE FOR MAHAMID'S CLAUDE

1. **Repositories**, mirrored on both accounts; `main` is the integration branch:

   | Repo | Owner account | Mahamid account | Local path (owner's Mac) |
   |---|---|---|---|
   | Platform | `2ms-muzammil/trading-scene-platform` | `MuhammadMuhamid/my-tradingview-clone` | `Trading-Scene-Work/platform` (code under `platform/{backend,frontend}`) |
   | Bot | `2ms-muzammil/trading-scene-bot` | `MuhammadMuhamid/3commabotclone` | `Trading-Scene-Work/bot` |
   | Research | `2ms-muzammil/trading-scene-research` | `MuhammadMuhamid/pythoncryptobacktesingsystems` | `Trading-Scene-Work/research` |

2. **Reading order:**
   1. this file;
   2. Platform `docs/OPERATIONS.md`: the halt table, the `/bot` workflow, §11 operator questions;
   3. Bot `README.md` → the "Control routes" section and the D2/D1 notes, then `docs/BOT_COMPLETE_GUIDE.md`;
   4. Platform `docs/ACCOUNTS.md` and `docs/ARCHITECTURE.md`;
   5. Platform `docs/TRADING_SCENE_UI_UX_CONTRACT.md` before any UI change.
3. **Architecture in one paragraph.**
   - The **Platform** (Fastify + PostgreSQL + Next.js) decides and is the only user interface.
   - The **Bot** (Express + Prisma/SQLite) is a **separately deployed executor**. It alone holds Binance keys and encryption material, runs the ~30 s TP/SL poller and reconciliation, and receives TradingView *exit* webhooks.
   - **Research** is offline.
   - The Platform talks to the Bot only over the signed HMAC + single-use-nonce channel under `/api/manual-trading/*`, which the Caddy rule restricts to the Platform's IP.
   - This campaign kept that boundary and added **operating controls** for the Bot inside the Platform's `/bot` page.
4. **Current status.** This document belongs to the accepted change set that the owner fast-forwards onto `main` and pushes to both accounts (see §12). Check what your remote `main` actually holds with `git ls-remote`. **Nothing has been deployed.** Production still runs the older revisions recorded in `docs/OPERATIONS.md` §10.
5. **Safe working boundaries:**
   - Do not move exchange keys or Bot encryption material into the Platform.
   - Do not merge the Bot into the Platform process.
   - Do not run `DRY_RUN=false` (even testnet) until the testnet round trip in §15 is done and reviewed.
   - Do not "simplify" the protection display: it must never show TP/SL as protected unless the Bot reports it is checking (§8).
   - Do not reinstate raw-URL checks in the session gate (§4, G1).
   - Do not let a link-mode OAuth callback mint a session (§4, A1).
   - Never pass a Platform `requestId` as a Bot webhook `dedupe_key` for operator commands (it would emit realization events).
   - **Owner decisions in §14 are not yours or Claude's to settle. Ask.**

---

## 1. Baseline (both accounts' `main` were identical at the start)
| Repo | Baseline `main` |
|---|---|
| Platform | `9d7fae6` (your 11 commits through the Packages ledger API) |
| Research | `2578f81` |
| Bot | `8d70730` ("Keep a manual trade's price and open P&L current") |

The previous campaign's evidence is in `Trading-Scene-Campaign/Integrated-Product-Reconciliation-2026-11-08/` on the owner's SSD; it reproduced D1, D2, D3 and A1. This campaign's evidence is in `Trading-Scene-Campaign/Integrated-Engineering-Finish-2026-11-09/`.

## 2. Purpose and intended product
- **One Trading Scene product:** chart, studies, alerts, watchlists, strategies, Shariah, the Trade panel, manual and automated orders, Journal, Operations, Research access and the self-hosted 3Commas-style Bot are all operated from one interface.
- **The Bot stays a separate service with its own database and key custody.** Separate backend ≠ separate product.
- **Standard users** chart and keep their own data, privately. They do **not** get exchange keys, trading or a Journal; that would be a new multi-tenant design and is an owner decision.
- **The owner's rules:**
  - preserve financial behaviour;
  - never fake a fill or real-money P&L;
  - no speculative fixes;
  - a consequential policy choice is presented, not invented.

## 3. Problems confirmed and corrected (summary)
| ID | Repo | Problem (reproduced at baseline) | Correction | Status |
|---|---|---|---|---|
| **A1** | Platform | An unverified squatter could link their own GitHub/Google to someone's email; the owner's later provider sign-in "reclaimed" the account but kept the squatter's link → takeover | §4 | fixed, tested, Fable-reviewed |
| **G1** (new) | Platform | The session gate checked the **raw** URL while Fastify's router decodes it: Standard users reached admin `POST /api/layouts/sync-deployments` via `sync%2Ddeployments` / `%73ync…` / `#x` (200, admin deployment settings copied into their layouts); encoded sign-in paths escaped the rate limit | §4 | fixed, tested over real HTTP, Fable-reviewed |
| **D2** | Bot | `-1006`/`-1007`/5xx and code-less errors were booked as **rejected** and never reconciled; a fresh strategy signal then placed a **second BUY** | §8 | fixed, tested, Fable-reviewed (2 rounds) |
| **D1** | Bot | A partially filled manual LIMIT BUY → TP/SL exit → later fill **resurrected** the closed trade at the full quantity; protection then refused on "balance drift". The scout also found: repeat phantom sells, a duplicate exit resubmission, and an exit sized from a stale snapshot | §8 (policy-neutral only) | fixed, tested, Fable-reviewed; **policy = owner decision OD-1** |
| **D3** | Platform | The Journal hard-coded `environment: "REAL"` (manual and automated); the chart said DRY_RUN for the same order; dry-run/testnet counted as "real money" | §8 | fixed, tested, Opus-reviewed (3 rounds) + final Fable |
| U1 | Platform | Operations said the Bot was "NOT CONFIGURED" while it worked (it only looked at custom webhook deployments) | §5 | fixed |
| U3/U4/U5 + Bot 0.3-0.7 | Bot | Manual-trade Close said "bot was deleted, close on Binance"; empty entry-JSON box; testnet unticked; a re-halt overwrote the daily-loss latch; halt hidden in DRY_RUN; wrong halt prompt; EditBot Reveal empty; deleting a bot orphaned its trades | §5 | fixed |
| P1/P2 | Platform | Packages replay ignored the member; a retry after a state change gave 409; a withdrawal replay gave 201; deleting an account with a membership gave 500 | §4 | fixed |
| Browser D-1…D-10 | both | `/bot` outcomes not rendered under dev (StrictMode ref); profit shown as "Daily loss"; Create Bot blocked by input step (pre-existing); dry-run positions labelled TESTNET; page overflow from `sr-only`; Operations "Halted" did not say which switch | §11 | fixed |

## 4. Accounts and authorization (A1, G1, P1/P2)
**A1 corrections** (`platform/backend/src/api/routes/auth.ts`, `repositories/users.ts`, `security/google.ts`):
- **Reclaim** (`joinProviderByEmail`). A provider sign-in that finds an **unverified** account with that email does all of the following in **one transaction with the user row locked**: clears the password, the TOTP secret/flag/last step, the recovery codes, **both** `google_sub` and `github_id`, push subscriptions and outstanding verification tokens; sets the avatar to the provider's; marks the email verified; bumps `session_version`; links the provider in use. A unique conflict rolls back with no 500. A verified account only gets the link.
- **Link mode** (`linkProviderForSession`). Needs a verified email, **or** a provider whose verified email equals the account's (which then verifies it); the admin counts as verified. The OAuth state carries the **session version** it started under, and the callback must arrive with the **same signed-in session at the same version**. Each state works once (`claimState`), and **no new session is minted**.
- **Password change.** `/api/auth/password` is compare-and-set on the session version and the current hash (`setPasswordIfCurrent`).
- **Email verification.** `/verify-email` consumes the token only on an explicit "Confirm my email address" click, so link scanners cannot verify someone else's account.
- **2FA** is still required on every provider sign-in to a 2FA account.
- **Invariant:** a verified identity is never equated with an unverified email; two unrelated verified people are never merged.

**G1 corrections** (`security/requestUser.ts`, `api/server.ts`, `api/routes/layouts.ts`):
- `canonicalRequestPath()` mirrors find-my-way 9 under Fastify 5 defaults: it strips the absolute-form prefix, cuts at `?`/`#`, rejects encoded slash, malformed escapes and a missing leading `/` with 400, and `decodeURI`s while keeping reserved escapes.
- One onRequest hook sets `req.gatePath`. The rate limiter, `PUBLIC_PATHS` and the session gate all use it.
- `userMayReachRoute()` adds a route-pattern backstop for admin-only routes, and `sync-deployments` checks `isAdmin` itself.
- **Invariant:** the gate decides on the path the router dispatches.

**Packages** (`repositories/packages.ts`, `api/routes/packages.ts`, `repositories/users.ts`):
- the replay compares `membership_id`;
- a replay is checked before the state checks;
- a withdrawal replay returns 200;
- deleting an account with a membership returns 409 (the ledger is append-only).
- There is still **no Packages UI and no money movement**.

**Ten-user isolation** (`tests/tenUserIsolationDb.test.ts`, `tests/sessionGatePathDb.test.ts`):
- **Users:** 10 Standard users, 1 admin, and signed-out, stale and unverified identities, against a real PostgreSQL.
- **Owner-only access:** each user can create, read, update and delete their own watchlists, layouts, Pine scripts, drawings, pane studies, alerts (including bulk), alert events, push subscriptions, profile, sessions and package memberships. No one can list, read, update or delete another's, whether by real id, guessed UUID, nested id, a body naming another owner (on create and update), a different verb, pagination, a stale cookie or an account switch.
- **Admin routes:** 28 admin-only routes return 403 for Standard users.
- **Admin scope:** the admin does **not** see Standard users' data through the user routes; Packages admin is the one intended exception.
- **Shared, read-only data:** candles, symbols, published Shariah, scanner reads and the built-in Pine library.
- No ownership-predicate defect was found.
- There is no client-facing WebSocket to test.

## 5. Bot inside Trading Scene (one product, separate executor)
**Bot routes** (`bot/backend/src/routes/manualControl.ts`, `services/controlCommands.ts`, `services/tradeExit.ts`):
- **Mounting and auth:** all under `/api/manual-trading/control/*`, mounted after `requireManualAuth` (HMAC-SHA256 over `METHOD\npath\nts\nnonce\nrequestId\nsha256(canonicalJson(body))`, ±60 s, single-use `ManualNonce`). The `/control/` prefix is control plane, so it works with `MANUAL_TRADING_ENABLED=false`.
- **Rate limits:** the control routes have their own limiters (GET 120/min, writes 60/min), so polling cannot starve a halt.
- **Every POST/PATCH** carries `actor{platformUserId, stepUp{method, at}}`, inside the signed body.

| | Route | Effect |
|---|---|---|
| C0 | `GET /status` | dryRun and halt (independent), routing, limits + snapshot (+latched), bots, protection, Shariah floor, manual |
| C1 | `POST /halt` | `haltBotTrading`: **never overwrites an existing halt** (keeps the daily-loss latch) |
| C2 | `POST /resume` | `resumeBotTrading` (re-checks a daily-loss latch; CAS; `still_breached` / `halt_changed`) |
| C3/C4 | `GET`/`PATCH /risk-limits` | the same bounds as the dashboard; a change never clears a latch |
| C5 | `POST /bots/:id/status` | target-state `setBotStatus`, plus an unresolved-intent count |
| C6 | `POST /trades/:id/close` | `closeStrategyTrade` → `processWebhook(…, {skipExitCheck, expectSmartTradeId})`. Refuses `trade_manual`, `bot_deleted`, `bot_paused`, `pair_not_listed`, `ambiguous_trade`, `exit_recent`; pending → 202 |
| C7 | `POST /trades/:id/partial-close` | `partialCloseStrategyTrade`: lock, **resolves earlier strategy SELLs first** (`exit_unresolved`), attempt, D2 classifier for the outcome, typed pre-wire `not_executed` |
| C8 | `GET /commands/:requestId` | the stored result, with **live** intent/attempt state whenever an order id is recorded |

**Idempotency** (`BotControlCommand`, migration `20261109130000_bot_control_command`):
- an insert-first claim; the command hash excludes the actor;
- the same hash replays the stored result; a different hash → 409 `request_id_reused`; `processing` → 409 `command_in_progress`; **a command is never re-run**;
- the intent/attempt id is written **before** the wire call, so C8 can tell the truth after a crash.

**Platform routes** (`platform/backend/src/api/routes/botControl.ts`, `manualTrading/client.ts`, `repositories/adminAudit.ts`, `operations/botStatus.ts`):
- **Mapping and access:** `/api/bot/control/*`, one Platform route per Bot command. Admin-only by the default-deny gate; mutations are refused when `AUTH_ENABLED=false`.
- **Request validation:** bodies are rebuilt from validated fields; path ids are UUIDs, URL-encoded; the requestId is required and **never minted** by the Platform.
- **Step-up:** TOTP when 2FA is on (the same for password, Google and GitHub sessions); the admin password only for **halt** when 2FA is off; otherwise `two_factor_required` / `step_up_unavailable`. The credential never reaches the Bot, logs or audit.
- **Outcomes:** only a Bot-authored JSON 2xx, or a 4xx with a code, is definitive. Timeouts, 5xx, proxy errors and `command_in_progress` are **uncertain** → the UI polls C8 (≤1 per 2 s, ≤60 s). "Nothing was changed" appears only when C8 answers `command_not_found`.
- **Audit:** `admin_audit` rows `bot.<kind>.requested` / `.succeeded` / `.refused` / `.uncertain`; 2FA setup/enable/disable rows for admins.
- **U1:** `readBotStatus` uses the signed C0 first, and Operations and `/bot` show separate named facts (channel, signed reachability, webhook path, dry run, halt/latch, routing, limits, Shariah floor, protection, manual/mainnet).

**UI** (`platform/frontend/app/bot/page.tsx`, `components/bot/*`, `app/operations/page.tsx`):
- **Bot statuses:** a status strip, with the Bot halt and the Platform halt as two cards each saying what it blocks.
- **Commands:** step-up dialogs; risk limits with units; start/stop; Close/Partial for **strategy** trades only (manual trades link to the chart Trade panel).
- **Outcomes:** outcome-unknown polling.
- **Layout:** a 390 px card layout.
- **Appearance:** an opt-in **Classic Bot appearance** (per browser, `/bot` only, dark only; documented exception in UI contract §2).

**Shared signing vector:** asserted identically by both repos' tests.

**What stays separate:**
- the Bot process and server;
- its SQLite ledger;
- the keys and `ENCRYPTION_KEY`/`SCRYPT_SALT`;
- the TP/SL poller;
- webhook ingress;
- the standalone dashboard, which remains the **recovery/break-glass** path.

**Not in Trading Scene yet:**
- bot create/edit/delete (needs a server-to-server secret hand-off);
- closing a paused or deleted bot's trade, or one of several same-pair trades (needs a reviewed trade-id-targeted exit);
- key entry (stays on the Bot by design).

## 6. Platform ↔ Research ↔ Bot
- Unchanged in principle: the Platform decides; the Bot executes; Research is offline and never sends orders.
- The cross-repo contract test (`platform/backend/tests/crossRepositoryRealization.test.ts`, run with `TRADING_SCENE_BOT_ROOT`) passes: the webhook contract is byte-identical, and the realization loopback survives duplicate replay.
- Research changed only in docs:
  - 15 registered trees;
  - only the five search trees have `show.py`;
  - controller corrections;
  - real test commands.

## 7. Roles
- **Admin:** everything, including `/bot`, Trade, Journal, Operations, deployments, Shariah management and Packages admin.
- **Standard:** chart, drawings, studies, Pine, watchlists, alerts, screener (read), Shariah (read), profile and 2FA (after email verification), Packages browse/join (needs a verified email + 2FA), portfolio.
- **Standard users never get** the Bot, manual trading, the Journal or Operations (403).

## 8. Money-path semantics (read before touching the Bot)
**D2: uncertain outcomes** (`bot/backend/src/services/binance.ts` `classifyExchangeFailure`, used by every submit path):
- **Definite rejection** only for: `-1013`; `-1100…-1131`; `-1021`; `-1022`; `-1002`; `-2014`/`-2015`; `-1003`; `-1015`; 429/418 with no code; `-2010` *except* "Duplicate order sent"; a local `PreWireError` (thrown before any wire call) or a `ShariahEnforcementError`.
- **"Duplicate order sent."** → query by client id.
- **Everything else is uncertain:** `-1006`/`-1007`/`-1000`/`-1001`/`-1008`, unknown codes, 5xx, `fetch failed`, timeouts. The order stays `submitted` with the reason recorded.
- **Reconciliation:** query-first by the **original** deterministic client order id. A definitive not-found **60 s** after submission → `rejected/ABSENT` (the existing exit rule, now applied to BUYs and manual SELLs too). A lookup failure never closes an order and alerts after 3 cycles.
- **No duplicate exposure:** while a strategy BUY for that bot/pair is unresolved, a fresh BUY → the existing `risk_blocked` (409). The risk snapshot counts unresolved BUYs. A webhook-admission gate refusal CASes `requested → rejected`.
- **`runIdempotentManualCommand`:** compares a body hash (migration `20261109120000_manual_command_body_hash`) and never re-runs. `submit_order` replays the existing order; `cancel` re-runs after claiming the row; `update_protection` returns 409.
- **Dry-run cancel guard:** under `DRY_RUN=true`, cancelling an order with a **real** exchange id is refused (`live_order_in_dry_run`), and a real id is never overwritten by `dry-…`.

**D1: policy-neutral invariants** (`services/manualTrading.ts`, `manualProtection.ts`):
- **I1:** a closed trade is never reactivated.
- **I2:** snapshots are monotonic deltas (remaining = acquired − exited).
- **I3:** an exit ≤ min(position, free balance net of other tracked positions in the asset).
- **I4:** a **late fill on a closed trade becomes a separate position**, `protectionState: late_fill_unprotected`, with no TP/SL, a plain "LATE FILL … NOT protected by TP/SL" message, and sellable via the Trade panel.
- **I5:** an entry still working after exit is flagged.
- **I6:** a protection exit is marked `submitted` before the wire, and queried before any resubmit.
- **I7:** dust closes.
- **I8:** an **automated** protection exit refreshes the entry order first and sells everything acquired; a **manual** SELL never sells more than the operator asked.
- **Owner policy OD-1** (cancel the remainder first vs track late fills) is **not** implemented; placeholders mark where it plugs in.

**D3: execution environment** (`platform/backend/src/journal/environment.ts`, one rule for the Journal, overlays and timeline):
- **Labels:** `DRY_RUN | TESTNET | REAL | PAPER | UNKNOWN`.
- **REAL** needs per-row evidence: a non-`dry-` exchange id on an explicitly mainnet account. Automated rows count as Bot-delivered only with `source_system='BOT_CUSTOM_V1'`. **No row's environment is taken from the Bot's current mode.** Positions follow their own `dry-` id or their entry order's (the Bot's manual state now sends `manualOrderId`/`exchangeOrderId`).
- **Journal:** cards and groupings are separated by environment; "Real money" with no proven-real rows says so and counts the rest.
- **Deferred:** a realization `environment` field (owner decision OD-5) is needed before automated rows can be TESTNET or REAL.

**Protection display** (`platform/frontend/components/tv/positionProtection.tsx`):
- **"Protected" only when all hold:** active with a level, manual trading enabled on the Bot, the Bot reports `protection.polling === true`, `tradingHalted` is false, and the account is testnet or `mainnetPositionsChecked`.
- **Otherwise:** "TP/SL NOT BEING CHECKED · Bot halted / manual trading off / mainnet manual off / status unknown", with **no** Bot TP/SL chart lines. Late fills show "UNPROTECTED · late fill". A stale read after a Bot failure is unknown.
- **A Platform halt does not drive this**, because the Bot's pollers keep running.
- **Bot side:** `listManualState` sends `tradingHalted` and `protection.{polling, haltedBy, mainnetPositionsChecked, note}`.

**Halts (policy unchanged, now shown truthfully):**
- **Bot halt:** blocks webhook BUY and SELL (including TradingView exits), manual BUY and **both TP/SL pollers**.
- **Platform halt:** blocks automated emissions and new manual exposure.
- **Operator SELL, Close and Partial** pass both.
- **Shariah** is unchanged: BUY gated at the Platform and the Bot floor, SELL never blocked. The Bot floor shows separately on `/bot` and Operations.

## 9. Source paths and migrations
- **Platform backend:**
  - `api/routes/{auth,accountSecurity,botControl(new),journal,layouts,operations,packages,tradingOverlays}.ts`;
  - `api/server.ts`;
  - `journal/{environment(new),projection,types}.ts`;
  - `manualTrading/client.ts`;
  - `operations/botStatus.ts`;
  - `overlays/{projection,types}.ts`;
  - `repositories/{adminAudit(new),journal,packages,users}.ts`;
  - `security/{google,requestUser}.ts`;
  - `timeline/projection.ts`.
  - **No new Platform migration.**
- **Platform frontend:**
  - `app/{bot,chart,getting-started,journal,login,operations,profile,verify-email}/page.tsx`;
  - `app/globals.css`;
  - `components/bot/*` (new);
  - `components/tv/{ManualTradingPanel,TradingStateStrip,positionProtection(new)}.tsx`;
  - `lib/{api,executionEnvironment(new),operationsHealth}.ts`.
- **Bot backend:**
  - `services/{binance,manualTrading,manualProtection,manualExchange,strategyOrderIntent,webhook,riskControls,manualAuth,controlCommands(new),tradeExit(new)}.ts`;
  - `routes/{manualControl(new),manualTrading,operations,trades,bots,exchange}.ts`;
  - `index.ts`;
  - `prisma/schema.prisma`.
  - **Migrations, both additive:** `20261109120000_manual_command_body_hash`, `20261109130000_bot_control_command`.
- **Bot dashboard:**
  - `pages/{Dashboard,CreateBot,EditBot,Settings}.tsx`;
  - `components/{BotFormFields,ui}.tsx`;
  - `api.ts`.
- **API contracts:**
  - new `/api/bot/control/*` (Platform) ↔ `/api/manual-trading/control/*` (Bot);
  - additive fields on the Bot's `/api/manual-trading/state`;
  - dashboard route status changes: Close/Partial not-found 404, not-active 409, no credentials 422, unknown outcome 202, manual trade 409 `trade_manual`, recent duplicate close 409 `exit_recent`;
  - `POST /api/exchange-accounts` now **requires** a boolean `testnet`.
- **Commit history:** see `git log --first-parent` on `main` for the campaign merges. On the Platform and the Bot, each workstream was merged with `--no-ff` and a descriptive message (sec, iso, truth, botui, docs on the Platform; exec, cmd, docs on the Bot), plus a few integration commits. Research has only direct docs commits.

## 10. Independent reviews (actual models)
- **Model availability:** Fable 5.1 (`claude-fable-5-1`) was confirmed selectable. Opus 5.5 (`claude-opus-5-5`) was the lead, the implementers and the D3 reviewer.

| Subject | Reviewer | Verdict → disposition |
|---|---|---|
| Bot control contract | Fable 5.1 | accept with 11 required changes → contract v1.2 |
| A1 + Packages | Fable 5.1 | accept with required changes (login and profile copy, ACCOUNTS.md) → applied |
| G1 + ten-user suite | Fable 5.1 | accept with required evidence (forged-owner creates, events pagination, inventory accuracy) → applied |
| D2/D1 | Fable 5.1 | required: a manual I8 oversell (asked 0.4, sold 0.7), and a refused BUY blocking entries for 15 min → fixed; re-review **ACCEPT** |
| Bot control routes | Fable 5.1 | required: C8 live state after a crash; plus atomic delete and `exit_recent` → applied |
| Platform controls | Fable 5.1 | required: `command_in_progress` was shown as a refusal (double-issue risk), a field-name mismatch, and others → fixed; re-review **ACCEPT** |
| D3 | fresh Opus 5.5 | 3 rounds: chart lines drawn without protection, halted/mainnet shown protected, stale reads → fixed |
| **Final combined (all 3 repos)** | Fable 5.1 | **ACCEPT WITH REQUIRED CHANGES**: no blocker, no required code change, one Research doc fix (applied). The final delta after the browser fixes, the last Bot delta and this handoff: **ACCEPT** |

Review files are in the campaign folder `reviews/`.

## 11. Testing evidence
- **Defect reproduction:** every defect was reproduced red before its fix; logs are in the campaign `logs/`.
- **Final run:** at the integrated heads, at quiet load, with the stack stopped:

| Repo | Suite / check | Result |
|---|---|---|
| Platform | backend tests, with the Bot root supplied (cross-repo test runs) and real PostgreSQL | **1674/1674**, 0 skipped |
| Platform | backend typecheck (src, scripts, tests), eslint `--max-warnings=0`, `tsc` build | pass |
| Platform | frontend unit tests / DOM tests | **1611/1611** / **747/747**, 0 skipped |
| Platform | frontend typecheck, eslint, **`next build`** (production) | pass |
| Platform | `scripts/ci/scan-secrets.sh` | clean |
| Bot | backend tests | **556/556**, 0 skipped (the scheduler timing test passed this run; it is known to flake under heavy CPU load) |
| Bot | backend typecheck, eslint, `tsc` build | pass |
| Bot | dashboard tests | **25/25** |
| Bot | dashboard typecheck, eslint, `vite build` | pass |
| Bot | `scripts/ci/scan-secrets.sh` | clean |
| Research | Python `unittest` / Node `.mjs` / TypeScript | **262 OK** / **127/127**, 0 skipped / **29/29**. They need the sibling `../platform` layout: from a non-sibling checkout, 11 Python errors, 1 Node failure and 4 skips appear, which is environment-only (documented in the Research README) |

The commands are in each repo's README. The logs, with commands, timestamps and exit codes, are in the campaign folder `logs/suites-final/`. The isolation-specific evidence is in `TEN_USER_ISOLATION_MATRIX.md` there.

- **Browser (local, sandboxed, fake Binance, `DRY_RUN=true`):**
  - journeys A-H, plus a re-check after fixes;
  - 117 screenshots;
  - `reviews/browser-walkthrough.md`.
- **Not verified:**
  - real Binance (testnet or live);
  - real Google/GitHub OAuth and SES;
  - the Caddy rule's case and double-slash handling;
  - production configuration;
  - a two-physical-Mac Research run.

## 12. Git synchronization
- **Before the push:** at the start of synchronization, all six remote `main`s equalled the baseline in §1. No collaborator commits arrived during the campaign.
- **Push method:** `main` was fast-forwarded to each repo's accepted integration branch and pushed normally to both accounts. There was no force push and no rewrite.
- **Workflows:** GitHub Actions in all three repos are CI-only (no deploy, no AWS credentials).
- **CI after the first push:** Bot and Research CI passed on both accounts. Platform CI (Node 22) cancelled two `botControlClient` tests: their hanging fake fetch relied only on `AbortSignal.timeout()`, whose timer does not keep the event loop alive. Node 26 locally did not show it. A test-only fix (a keep-alive interval in the fake transport) was reproduced red→green on Node 22.23.4, and the full Platform backend then passed on Node 22 (1674/1674). It was pushed as a follow-up commit. **Run the suites on Node 22 as well as your local Node.**
- **Final SHAs:** recorded, after a read-only `git ls-remote` check of all six remotes, in the owner's campaign report (`FINAL_IMPLEMENTATION_REPORT.md` §Git). A file cannot contain its own commit id, so the Platform head is the commit that adds this file **or a later one** in the same campaign. One test-only follow-up came after it; see the next bullet. At the time of writing, the integration heads were Bot `98c2cce` and Research `99f32ca`, or a later docs-only commit if one was needed.

## 13. Accepted source vs production
- Production is **not** running any of this. Per `docs/OPERATIONS.md` §10 (your log), production ran Platform `72ea65f` and Bot `8d70730` with `DRY_RUN=true` and testnet.
- **Deploying needs:**
  - **Bot first:** two additive migrations; back up first.
  - **Then the Platform.**
  - **Admin 2FA turned on** before using the Bot controls.
  - Platform migration `053` still needs `btree_gist` in production.
- See the owner's `OPERATIONS_OWNER_CHECKLIST.md`.

## 14. Open items: owner decisions, risks, not implemented
- **OD-1:** D1 policy (cancel the remainder first vs track late fills; recommended: cancel first, then sweep any race fill). The interim is safe and visible.
- **OD-2:** step-up defaults (halt by password while 2FA is off). Turn on admin 2FA.
- **OD-3:** two halts vs one; a Bot halt that keeps TP/SL running.
- **OD-4:** key custody stays on the Bot; when to restrict the public Bot dashboard.
- **OD-5:** the realization `environment` field (Platform first, then the Bot).
- **OD-6:** `admin_audit.actor ON DELETE SET NULL` conflicts with the append-only trigger (pre-existing, migration 053). Deleting an audited account fails; only admins are audited today.
- **OD-7:** Trade-panel SELL defaults ("Unassociated wallet sell"; 100% = wallet).
- **Pre-existing UX notes:**
  - an operator Close is recorded as `signal_exit`;
  - `/chart?symbol=` is ignored without `source=scanner`;
  - a dev hydration warning from the shared `useSession`;
  - manual orders have no step-up.
- **Operational, unverified:**
  - the old `tradingbot` EC2;
  - the rotation of the webhook secret in public Bot history;
  - an off-server key copy and a restore drill;
  - the production migration count.
- **Never done:** a `DRY_RUN=false` testnet round trip.

## 15. Next steps for you and your Claude Code
1. Read §START and §8, then run the suites locally (commands in Platform `README.md`, the Bot `README.md` and Research `README.md`). Use your own `DATABASE_URL` prefix per worktree.
2. Work through the operator checklist with the owner: old EC2, webhook-secret rotation, off-server keys, restore drill, migrations.
3. Turn on admin 2FA. Deploy the Bot (with a backup), then the Platform, only when the owner agrees.
4. Do **one reviewed testnet round trip** with `DRY_RUN=false`: BUY, TP or SL, SELL, a Bot restart, a halt, a Shariah refusal, and an uncertain-outcome drill if possible.
5. **Do not undo:**
   - the canonical gate path;
   - link-mode session binding;
   - the reclaim transaction;
   - the D2 classifier and the unresolved-BUY block;
   - I1-I8;
   - the protection display rule;
   - the never-re-run command ledger;
   - the step-up rules.
6. **Do not assume:** that the Bot halt keeps TP/SL running (it does not); that automated Journal rows can be REAL (they cannot, until OD-5); or that Standard users can trade (they cannot).
