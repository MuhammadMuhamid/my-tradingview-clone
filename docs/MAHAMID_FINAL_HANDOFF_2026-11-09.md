# Final engineering handoff, 2026-11-09 (V3): Bot parity and owner decisions OD-1 to OD-7

**From:** the owner (2ms-muzammil), working with Claude Code (lead: Opus).
**To:** Mahamid (MuhammadMuhamid) and his Claude Code.
**Status of this file:** canonical. It supersedes `docs/MAHAMID_HANDOFF_2026-11-09.md` (the earlier same-day handoff stays for the history of the first half of the campaign).
**Nothing in this mission was deployed.** No AWS, SSH, production database, real or testnet order, OAuth, email, 3Commas call or key rotation happened. Everything below was built and verified against fakes and disposable local stacks. Production steps are listed for Mahamid to run later (sections 5 and 9).

The mission did two things:

1. Brought the Bot operations of the Classic (standalone) Bot dashboard into Trading Scene's `/bot` area, so the administrator can operate the Bot from one login.
2. Implemented the seven owner decisions OD-1 to OD-7.

**This is not 100% parity.** Three Classic features are not ported (section 11). Read that section before telling anyone the Classic dashboard can be retired.

---

## 1. Read order

1. This file, end to end.
2. Platform `docs/OPERATIONS.md`: the halt table, pause new entries, the `/bot` workflow, section 11 operator questions.
3. Platform `docs/ACCOUNTS.md`: step-up grants, account deletion, admin 2FA reset.
4. Platform `docs/SECURITY-POSTURE.md` and `docs/ARCHITECTURE.md` ("Bot page: read and control boundary").
5. Platform `platform/deployment/aws/BOT-DEPLOY.md`: the deploy order and environment.
6. Bot `README.md` ("Platform control routes", "Realization contract v2") and Bot `deploy/ENROLLMENT.md` (reverse proxy for key enrollment).
7. Bot `docs/BOT_COMPLETE_GUIDE.md` for the model-level detail.
8. `docs/TRADING_SCENE_OWNER_GUIDE.md` for the owner-facing description.
9. The campaign folder (owner's SSD), `Bot-Full-Parity-And-Owner-Decisions-2026-11-09/`: `ENGINEERING_DECISIONS_AND_SAFETY.md` (frozen design), `BOT_FEATURE_PARITY_MATRIX.md` (88 rows plus the exceptions), `TEST_REVIEW_LEDGER.md`, `reviews/` (independent reviews, browser acceptance), `GIT_AND_CI_MANIFEST` (final pushed SHAs).

---

## 2. What changed and why

### 2.1 Per owner decision

| OD | Decision (as implemented) | Where |
|---|---|---|
| OD-1 | **Cancel the working entry first, then sweep any race fill.** A full exit (TP, SL, or a full manual SELL) of a position whose LIMIT entry is still working cancels the entry first, re-reads what filled, and sells the fresh quantity. A fill that lands between the cancel and the sell becomes a `race_fill_sweep` position, swept by the poller (at most 3 attempts, then an operator hand-off with an alert). Partial exits never cancel. | Bot |
| OD-2 | **Low-friction 2FA with server-validated step-up grants.** One TOTP proof mints a 5-minute grant (cookie `srtrend_stepup`, HttpOnly, SameSite=Strict, only a hash stored, never extended). Apple Passwords is first class in the setup card. "Lock now" revokes the grant. | Platform |
| OD-3 | **Pause new entries**, independent of halt. One action pauses both halves: the Platform flag and the Bot flag. Exits, TP/SL, cancels and sweeps keep working. | Both |
| OD-4 | **Exchange keys are entered only on the Bot origin.** The Platform mints a single-use enrollment link; the browser goes to the Bot's `/enroll` page. The Platform never sees, stores or logs a key. | Both |
| OD-5 | **Journal realization environment.** Realization events carry `environment` (DRY_RUN, TESTNET, MAINNET, UNKNOWN), so the Journal no longer shows "Unknown environment" for new events. Contract v2, Platform first. | Both |
| OD-6 | **Genuine self-service account deletion**, with step-up, anonymised membership and ledger history, and an audit trigger that allows only the actor to become NULL. | Platform |
| OD-7 | **SELL 100% means the selected position**, not the wallet. The Bot refuses a SELL larger than the position (409 `sell_exceeds_position`) and accepts `positionFull`. | Both |

### 2.2 Per parity area (Classic dashboard to `/bot`)

All the Bot-side work is behind signed control commands C9 to C19 (section 4). The Platform proxies each one, adds the step-up tier, writes `admin_audit` rows before and after, and renders it.

- **Overview** (`/bot`): status strip, halt cards, pause card, risk limits, metric cards, bots table with filter chips, start/stop with a start summary, trades tabs with all Classic columns and closed-reason badges, history summary, Close and Partial, 15-second silent refresh.
- **Create and edit a bot** (`/bot/bots/new`, `/bot/bots/[id]`): every Classic field and its validation (the Bot's server rules are authoritative), free USDT under the account select, delete with refusals, secret rotation.
- **Webhook secret handling (better than Classic):** the secret is issued Bot to Platform server-side, stored encrypted in `bot_webhook_secrets` (migration 058), and never reaches the browser, the replay cache, a log or an audit row. "Link to deployment" copies it server-side into a custom deployment. The Bot-origin reveal page shows it once on demand, with the exit-only TradingView JSON.
- **Accounts** (`/bot/accounts`): list with key hint and usage, balances, enrollment (create, replace), removal with refusals, typed `MAINNET` for mainnet.
- **Targeted operator exits:** Close and Partial are now by trade id. They work for a paused bot's trade, a delisted pair and a twin trade on the same pair. The refusals `bot_paused`, `pair_not_listed` and `ambiguous_trade` are gone; `trade_manual` and `bot_deleted` remain. The Classic dashboard shares the same code.
- **Shared Classic fixes (break-glass keeps working):** X5 (changing a bot's account while it has open trades is refused), server-verified `MAINNET` confirmation, pause control and pill.
- **Safety blockers fixed first (X1 to X7):** no request body or key-like text in error logs; secrets and tickets never stored in the replay cache; manual full SELL takes the per-trade close lock; rotation refused while SELLs are unresolved; netting-aware late fills.

---

## 3. Baseline to integration

| Repo | Baseline (all six remote mains were equal at Gate 0) | Integration branch (`v3/integrated-20261109`) |
|---|---|---|
| Platform | 0afaeec | head at the time of this file: 76b84b2 |
| Bot | 98c2cce | head at the time of this file: e3be135 |
| Research | 99f32ca | **unchanged** (no code change in this mission) |

The **final pushed SHAs** (including this documentation commit) are recorded in the campaign `GIT_AND_CI_MANIFEST`, not here, so this file does not need a new commit every time the heads move. Mahamid's mirror accounts get the same commits.

---

## 4. Cross-repo contract changes

Channel unchanged: HMAC over method, canonical path, timestamp, nonce, request id and body, ±60 s, single-use durable nonce, under `/api/manual-trading/*`. The Platform builds each body from validated fields; there is no pass-through proxy.

- **C0 `GET /control/status`** gains optional `entries` (`paused`, `pausedAt`, `pausedBy`, `reason`, `workingEntryLimits`, `unresolvedBuyIntents`, `uncertainBuyOrders`) and `capabilities: string[]`.
- **Capabilities:** `entries.v1`, `bots.v1`, `accounts.v1`, `enroll.v1` (only when `ENROLLMENT_ENABLED`), `operatorExit.v1`, `manualPositionFull.v1`. The Platform shows a feature only when the Bot lists it. An old Bot's absence reads as "unknown/hidden", never "off". Platform to Bot: the realization ingest answer carries `capabilities: ["realization.v2"]`.
- **C9** `POST /control/entries`: pause `{paused:true, reason 3..200, cancelWorkingEntries?}` or resume `{paused:false}`; target state, idempotent.
- **C10 to C14** (bots): create (201 with the secret, live reply only; the stored copy is `secretIssued:true`), read, partial edit, delete, rotate secret.
- **C15, C16, C19** (accounts): list with key hint, delete (`REMOVE_ACCOUNT`), balance.
- **C17, C18** (enrollment): mint a single-use ticket (create, replace, reveal_webhook) and read its outcome. The link is `https://<Bot origin>/enroll#t=<ticket>`; the Platform returns it with `no-store`, never stores it, and audits only the enrollment id.
- **C6, C7** keep their shapes but are now trade-id targeted.
- **`positionFull`** on a manual SELL: sell all remaining quantity of the position (plus any race delta), mutually exclusive with `baseQuantity`. Sent only when C0 lists `manualPositionFull.v1`. A `baseQuantity` above the position is 409 `sell_exceeds_position`. The Platform manual order route requires a browser-supplied `requestId`.
- **Realization v2:** v1 keys plus required `environment`. v1 batches are unchanged, so old Bots keep working. The contract module is byte-identical in both repos (a cross-repo test asserts it). The Bot emits v2 only for events persisted while `REALIZATION_CONTRACT_V2_ENABLED=true` and after the Platform acknowledged `realization.v2`. A Platform rollback to v1-only is handled without a Bot change (README "Realization contract v2"). A `MAINNET` claim with a `dry-` order id, or `DRY_RUN` with a real id, resolves to UNKNOWN (never "REAL" without proof).
- **New Platform routes:** `/api/bot/control/entries`, `/api/bot/manage/*` (C10 to C19 proxies), `POST /api/deployments/:id/link-bot`, `GET /api/auth/step-up/status`, `POST /api/auth/step-up/revoke`, rewritten `DELETE /api/auth/account`.
- **Linked deployments (final review fix):** a deployment linked to a Bot cannot change delivery or webhook URL without that destination's own secret (409 `deployment_linked_to_bot`), so the Bot's secret never follows it to another host.

---

## 5. Migrations and deployment order

### Migrations (all additive)

| Repo | Migrations |
|---|---|
| Bot | `20261110100000_manual_exit_cancel`, `20261110110000_entries_pause`, `20261110200000_exchange_account_key_hint`, `20261110210000_exchange_enrollment`, `20261110220000_realization_environment` |
| Platform | `054_account_deletion`, `055_step_up_grants`, `056_realization_environment`, `057_entries_pause`, `058_bot_webhook_secrets` |

The Bot applies its migrations with `prisma migrate deploy` at start. Platform migrations run through the normal release flow.

### Order

1. **Back up** the Bot SQLite file and the Platform Postgres.
2. **Deploy the Bot.** All new flags stay off. OD-1 cancel-first applies to new exits at once. **Legacy "entry still working" orders are not auto-cancelled** at deploy (a lead decision after the financial review); they stay flagged for the operator.
3. **Deploy the Platform.** It shows new features only when the Bot's C0 `capabilities` lists them, so either order is safe. Bot first is recommended.
4. **Turn on admin 2FA** before using the Bot controls.
5. **Enable enrollment:** configure Caddy or nginx as in the Bot's `deploy/ENROLLMENT.md`, keeping the `/api/manual-trading` Platform-IP rule; then set both environment sides.
6. **Set `REALIZATION_CONTRACT_V2_ENABLED=true`** only after the Platform is deployed (the Bot also waits for the Platform's `realization.v2` capability). **Never roll the Bot back past this version once v2 rows exist.**
7. **Controlled testnet round trip** with `DRY_RUN=false` on testnet-only accounts, mainnet manual trading off, operator present. **Never mainnet** before that passes and the owner authorises it.

---

## 6. Environment variables

All default off or unset. The listed values are examples.

| Side | Variable | Meaning |
|---|---|---|
| Bot | `ENROLLMENT_ENABLED` | `true` turns on `/api/enroll/*` and the `enroll.v1` capability. `PUBLIC_URL` must then be the Bot's https origin. |
| Bot | `PLATFORM_RETURN_URL` | Exact https return page, e.g. `https://mytradingview.alphawebstudioz.com/bot/accounts`. Never taken from a request. |
| Bot | `REALIZATION_CONTRACT_V2_ENABLED` | `true` after the Platform is deployed (step 6). |
| Platform | `BOT_PUBLIC_ORIGIN` | The Bot's public origin, e.g. `https://bot.alphawebstudioz.com`. Enrollment links on any other origin are refused; unset means `enrollment_not_configured`. |

**X8, same-site.** The Platform and the Bot are both under `*.alphawebstudioz.com`, so they are same-site, not cross-site. Every `/api/enroll/*` request must carry `Origin` equal to the Bot's public origin, `Sec-Fetch-Site: same-origin` and a JSON content type, else 403. The existing Classic dashboard relies on CORS preflight for its JSON-only APIs; CORS stays Bot-origin only.

---

## 7. Tests and reviews (summary)

Full log and per-slice red-to-green table: campaign `TEST_REVIEW_LEDGER.md`.

**Full suites on the integration heads (all exit 0, 0 skips):**

| Suite | Result |
|---|---|
| Platform backend | 1764/1764 (full backend run on the head before the last review fix; the last fix has focused tests, 30/30) |
| Platform frontend unit / DOM | 1631 / 799 |
| Platform typecheck, lint, `next build` | pass |
| Bot backend | 725/725 |
| Bot frontend | 41 (vite build ok) |
| Research | python 262 OK, node 127, typescript 29 (unchanged code) |
| Cross-repo byte identity and contract tests | Platform side 16/16, Bot side 10/10 (run with `TRADING_SCENE_BOT_ROOT` / `TRADING_SCENE_PLATFORM_ROOT`) |

The full Platform suite on the final head runs in GitHub CI (Node 22) on the pushed branch; there was no local Node 22.

**Independent reviews (fresh-context Fable reviewers):**

| Subject | Verdict | Outcome |
|---|---|---|
| Bot control (X1, X2, X5, X6, X8, C10 to C19, enrollment, OD-5) | accept with required changes, then **accept** | 1 required (OD-5 outbox stall after a Platform rollback) fixed, advisories 2 to 7 fixed |
| Bot execution (OD-1, OD-3, OD-7, targeted exits) | accept with required changes, two re-reviews, **accept** | double sell with an uncertain manual exit (F1) fixed; a never-sent `requested` SELL submitted after close (R1) fixed |
| Platform accounts (OD-2, OD-6, OD-5, OD-3, OD-7) | accept with required changes | resume-entries audit ordering fixed (red then green) |
| Final combined (both integration heads) | accept with required changes | R1 USDT bound mismatch and R2 matrix statuses fixed; A3 linked-deployment secret fixed in 76b84b2 |

**Browser acceptance (local, confined, fake Binance, DRY_RUN):** journeys J1 to J7, J9 and J10 passed. J8 partial, J11 not run (section 11). About 70 screenshots in the campaign folder. Two low defects were fixed after the run; two documented.

---

## 8. Owner decisions: what to tell the owner

- **OD-1** is cancel-then-sweep. It does not promise zero exposure: an unknown cancel leaves a window of at least one reconcile cycle (about 30 s) until a later query, and alerts say so. Binance cancel semantics were not verified against a real exchange (EXT-UNVERIFIED).
- **OD-2** trades some separation for convenience. If the password and the codes are both in Apple Passwords, sign-in is easier but the two factors are less separated than an authenticator on another device. The setup card says so. Risk-limit changes, enrollment links, secret rotation and anything that weakens protection still ask for a fresh code even inside a grant.
- **OD-3** pause is not halt. Pause blocks new positions only; halt stops automation in both directions. Use pause when you want to keep protection running.
- **OD-4** means the Platform cannot leak a key it never sees.
- **OD-5**: only new events carry an environment. Old rows stay "Unknown environment" (immutable).
- **OD-6**: the administrator account cannot be deleted this way; a member with an active cohort membership or a non-zero ledger balance is refused until settled.
- **OD-7**: "100%" means the selected position's quantity.

---

## 9. Roles

- `/bot`, `/api/bot/*` and the link-bot route are **administrator only**. A Standard user gets 403, an anonymous caller 401 (verified on all spellings probed, in tests and in the browser).
- Standard users are unaffected: no Bot controls, no exchange keys, no trading. Per-user trading remains an open owner decision (section 11).
- Account deletion is available to ordinary accounts (OD-6), not to the administrator.

---

## 10. Production checklist for Mahamid (not done in this mission)

- [ ] Decide the fate of the **old `tradingbot` EC2**, which may hold real keys and live settings. Keep it stopped until decided.
- [ ] **Rotate the historically public webhook secret** (it was exposed in public Bot git history; the repos are public by owner choice).
- [ ] **Off-server backup of `ENCRYPTION_KEY` and `SCRYPT_SALT`** and a **scratch restore drill**. Without those keys a restored database cannot decrypt its API keys.
- [ ] **Production migration discrepancy.** The `052` header says production has migrations the repo lacks (migration-count drift, `btree_gist` for `053`). Reconcile before running 054 to 058.
- [ ] **Real Caddy handling** for `/api/manual-trading` (Platform IP only) and the new `/api/enroll` (public, no IP rule; see `deploy/ENROLLMENT.md`).
- [ ] **Signed command route reachability** from the Platform host to the Bot.
- [ ] **Deployed versions and config:** confirm the running commits and every flag in section 6 against this file.
- [ ] **Testnet activation preflight** (section 5, step 7), operator present.
- [ ] **Restrict the Classic dashboard** to an allow-list or VPN, as break-glass only.
- [ ] Turn on administrator 2FA, then verify a halt, a pause and a Close end to end on testnet.

---

## 11. Open items (stated honestly)

### Not ported (EXCEPTIONS; not counted as parity)

88 Classic rows were inventoried: 85 are parity, superseded or not-in-standalone; **3 are exceptions**.

- **P-81, Bot execution push notifications.** Still only on the Classic dashboard (Settings, Mobile order notifications, Bot origin). The Platform's web push covers chart alerts only and receives no Bot execution events. True parity needs a Bot execution-event outbox, a Platform receiver and dispatcher to the admin's subscriptions, and tests. Not started.
- **P-70, delete a closed trade from history.** Deliberately not ported: the Classic hard delete removes realised-P&L rows that feed the totals and the daily-loss window, so it can unlatch a loss halt. It still exists on the Classic dashboard. A safe archive flag is proposed; the owner chooses: keep, convert to archive, or remove.
- **P-11, installable app.** Equivalent for installation only (Trading Scene is a PWA including `/bot`); Bot-specific notifications are P-81.

### Browser verification limits

- Classic dashboard journey **J11 was not run**. Its changes (MAINNET confirmation, pause control, key form, enroll page) are covered by Bot frontend and backend tests only.
- **J8 is partial**: not run were a just-closed position id, a BUY step-up while unpaused, and a position on a second account.
- Covered by automated tests only: the Bot-origin secret reveal, the link-to-deployment action, the old-Bot (capability-hidden) view, and cancel-working-entries with a live LIMIT. Mainnet withdrawal-enabled and no-IP warnings were not driven.
- Later fixes (434ecbb, d77276d, 76b84b2) were not browser-rechecked; they have focused tests.

### Advisories from the reviews (no change made)

- **A1 (pre-existing):** `/2fa/setup` accepts any password for provider-only accounts that have no password hash. Fix before relying on 2FA for such an account.
- **Uncaptured rotation:** if a secret rotation's reply is lost, linked deployments are refused by the Bot until the secret is rotated again. The page says so.
- **Deep link carries no account id:** the Bot trade view lacks one, so the Trade panel takes the account from the position. Multi-account is untested in the browser.
- **Edit tier uses a snapshot:** a millisecond race exists where a second holder of a live grant could undo a tightening; needs an `expectedUpdatedAt` field on C12.
- **Link-bot audit ordering:** the link commits before its audit row; a failed audit write is only logged.
- **Pause cancel outcomes** are dropped from the card if the pause settles through the command-status route (the live working-entries count still shows).
- **A typed 5xx from the Bot** (e.g. 503 `enrollment_misconfigured`) is shown as "outcome unknown" first.
- **A poisoned v2 row** can flap the realization capability (no stall).
- **EXT-UNVERIFIED Binance cancel semantics** (cancel reply fill fields, error -2011 meaning, testnet `/sapi` and `permissions` handling).
- **No zero-exposure guarantee** for unknown cancels (OD-1).
- Remaining small items: no typed confirmation for account removal beyond step-up; enrollment tickets are 5-minute bearer tokens; in-memory limiters; the netting wait counter resets on restart; the close lock is in-process only.
- The realization byte-identity test skips unless `TRADING_SCENE_BOT_ROOT` is set (no workflow sets it).

### Carried forward from the earlier campaign

- **Packages** custody and regulation are not solved; the ledger is not wired.
- **Per-user trading** (Standard accounts with their own keys) is not implemented; an owner decision.
- **3Commas** deployments and the production Shariah mode, `ALLOW_SIGNUPS` are production state not visible here.
- **Mainnet authorisation:** no real order has been placed on testnet or mainnet by this system. The owner must authorise mainnet after the testnet round trip passes.
