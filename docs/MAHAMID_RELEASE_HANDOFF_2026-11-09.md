# Release handoff, 2026-11-09 (closeout): execution push, Archive, browser acceptance

- **From:** the owner (2ms-muzammil), working with Claude Code.
- **To:** Mahamid (MuhammadMuhamid) and his Claude Code.
- **Status:** canonical successor for what changed in this closeout. For the earlier architecture and OD-1..OD-7, read [MAHAMID_FINAL_HANDOFF_2026-11-09.md](MAHAMID_FINAL_HANDOFF_2026-11-09.md) (still valid; marked superseded in part).
- **NOT DEPLOYED.** Nothing ran against production: no AWS, no SSH, no production database, no live or testnet Binance order, no real push service, OAuth or email. Everything was verified with disposable local databases, a fake Binance adapter and a sandbox that blocks external network access.

## 1. What changed in this closeout

| Owner decision | Result |
|---|---|
| Confirmed BUY/SELL execution push in Trading Scene (P-81) | **Done.** See §2. |
| Archive/Hide instead of deleting closed trades, in BOTH dashboards (P-70) | **Done.** See §3. The Classic `DELETE /api/trades/:id` now answers 410 and deletes nothing. |
| Keep the Classic dashboard fully available | **Kept**, not break-glass-only. All its features work against the changed Bot (browser J11). An allow-list or VPN in front of it is optional hardening. |
| Finish browser journeys J8 (Trade panel) and J11 (Classic) | **Both pass.** J8 found and fixed one bug (§5). |

The parity count was 85 of 88 Classic rows. It is now **88 of 88 covered in `/bot`**, with stated limits:
- **P-81** (execution push): device delivery was not live-tested.
- **P-70** (Archive): a safe replacement, not the old delete.
- **P-11** (install as an app): equivalent install metadata (SVG icon only; native install not device-tested).

## 2. Bot execution notifications (P-81)

**Trigger.**
- Only a **confirmed** execution counts: a fill the Bot's ledger booked.
- Each event is written in the same database transaction as the booking, at three places:
  - strategy BUY/SELL, including reconciler recovery after a crash or an unknown outcome;
  - TP/SL and partial exits;
  - manual orders.
- Never an event: a submitted, accepted, rejected, unknown, zero-fill or cancel-only order, or the X7 netting correction.

**Partial fills.**
- Strategy and exit orders: one event per order.
- Manual orders: one event per newly booked fill increment. Each event carries `orderComplete` and `cumulativeBaseQty`, so a later partial fill is never hidden.

**Environment.**
- The label comes from order-level records written when the order is created: `StrategyOrderIntent.executionEnvironment` (OD-5) and, **new**, `ManualOrder.executionEnvironment` and `ExchangeOrderAttempt.executionEnvironment`.
- Older rows read UNKNOWN.
- People see **REAL** only for a recorded MAINNET route with an exchange-assigned order id. Otherwise the label is TESTNET, DRY RUN or UNKNOWN.

**Transport (pull, so the Bot never depends on the Platform).**
- **Bot side:** the Bot serves `GET /api/manual-trading/control/executions?after=<seq>`.
  - It is signed with the existing manual/control HMAC, read-only and control plane.
  - It is advertised in C0 as `executions.v1`.
  - With no `after` it returns only the cursor, so a new reader does not replay history.
- **Platform side** (`platform/backend/src/botExecutions/notifier.ts`):
  - It polls every 15 s, only while an admin has opted in and the Bot lists the capability.
  - It stores each Bot event once (primary key = Bot event id) and moves the cursor in the same transaction, under an advisory lock.
  - It pushes through the **existing** web push and service worker; there is no second pipeline.

**Recipients and settings.**
- Recipients are admins (`role='admin'`, re-checked at send time) who opted in on the `/bot` *Execution notifications* card. The preference is off by default.
- Standard users get 403 from `/api/bot/notifications` and never receive Bot events.
- Device permission is the browser's normal flow, the same as for chart alerts. The card states the device's situation honestly: "can't receive", "add to Home Screen first" (iPhone/iPad), "blocked", or "registered".
- The notification links to `/bot`, which needs sign-in and admin; there are no ids in the URL. The payload carries no secrets.

**Retry and dedup.**
- **Source-event identity:** the event id is unique on the Bot, and the booking functions apply each fill once.
- **Delivery identity:** one row per (event, recipient), so a retry never re-sends to someone already delivered. The device `tag` is per event.
- **Retry limit:** a push failure is retried up to 3 times with backoff, then recorded as `gave_up`.
- **Staleness:** an execution older than 6 h is stored but not pushed (`expired`).
- **Feed reset:** a Bot feed that went backwards (database restored) resets the cursor.
- **Malformed events** are skipped without stalling the feed.
- There is no exactly-once network-delivery guarantee.

**Classic.** The Bot-origin push in Classic Settings → Mobile order notifications is unchanged. An admin who enrols on both origins gets both, by choice.

**Flag.** Platform `BOT_EXECUTION_NOTIFICATIONS_ENABLED` defaults to on. It does nothing until an admin opts in AND the Bot lists `executions.v1`; set it to `false` to stop the poller. The Bot has no new flag.

Contract details: `bot:backend/src/services/executionEvents.ts`. The shared fixture `tests/fixtures/executionEvent.v1.json` is byte-identical in both repos and is tested.

## 3. Archive instead of delete (P-70)

**One Bot rule for both UIs** (`bot:backend/src/services/tradeArchive.ts`):
- `SmartTrade.archivedAt` and `archivedBy` are presentation state only.
- Realized P&L, totals, *Realized today*, the daily-loss window, the halt latch and resume refusal still count archived trades.
- Every accounting and risk read ignores `archivedAt`; only the History listings filter on it.

**What can be archived.**
- Only `closed` trades with no open exit attempt, no unresolved strategy intent, no pending manual order or owed entry cancel, no protective order id, and no operator flag. Otherwise the request is refused with a code.
- Restore is always allowed. Requests are idempotent, and two concurrent requests write once.

**Classic.**
- The trash icon is now Archive/Restore, with a *Show archived* toggle and an ARCHIVED badge.
- The stats include archived trades ("Totals include archived trades").
- `DELETE /api/trades/:id` returns 410 `trade_delete_removed` and deletes nothing.

**Trading Scene.**
- `/bot` *Trade history* shows Archive/Restore and *Show archived*.
- The route is `POST /api/bot/control/trades/:id/archive` (admin, recent code, audited). It needs capability `tradeArchive.v1`.

**Account deletion (OD-6)** is unchanged: it is not a way to erase the executor's financial history.

## 4. Migrations, deployment order, rollback

| Repo | New migration (additive) |
|---|---|
| Bot | `20261111090000_execution_events` (table `ExecutionEvent`; nullable `executionEnvironment` on `ManualOrder`, `ExchangeOrderAttempt`); `20261111100000_trade_archive` (`SmartTrade.archivedAt`, `archivedBy`, index) |
| Platform | `059_bot_execution_notifications` (`bot_execution_feed`, `bot_execution_events`, `bot_execution_deliveries`, `bot_execution_notification_prefs`; user FKs cascade on account deletion; the Bot events themselves name no user and stay) |

**Order: either order is safe; Bot first is natural.** There is no new payload a receiver must understand before the emitter sends, because the Platform pulls.
- **New Platform + old Bot:** C0 lacks `executions.v1` and `tradeArchive.v1`, so the poller idles and the UI hides Archive and says "older Bot".
- **New Bot + old Platform:** the feed is never read. The Bot only appends rows inside existing transactions and prunes them after 30 days.
- **Rollback:**
  - Bot: the previous build ignores the new columns and table (keep the data; do not drop).
  - Platform: the 059 tables become unused; the drop SQL is in the migration header.
  - There is no outbox, so nothing can stall.
- **Archive rollback caveat:** an older Classic bundle would show archived trades again, but its old Delete route would come back too. Do not roll the Bot back past this version unless you accept that.

Back up the Bot SQLite file and the Platform Postgres first, as always. The existing readiness steps of the prior handoff (§5 steps 4-7) still apply.

## 5. Tests, reviews, browser acceptance

**Final integrated suites** (closeout integration heads; exact commands and logs are in the campaign folder `TEST_AND_REVIEW_EVIDENCE.md`):

| Suite | Result |
|---|---|
| Bot backend | 753/753 |
| Classic frontend | 44/44 |
| Platform backend | 1785/1785 (Postgres suites ran) |
| Platform frontend unit | 1631/1631 |
| Platform frontend DOM | 807/807 |

Lint, typecheck and the Next production build passed, and the cross-repo contract checks pass both ways.

**Reviews.** Two independent Fable reviews returned ACCEPT with 0 required changes:
- the combined money/security delta;
- the follow-up delta.

The advisories that mattered were fixed: late pushes after an outage, one bad row stalling the rest, and truthful outcome labels. The rest are listed in §6.

**Browser** (sandboxed local stack; screenshots and logs are in the campaign folder):
- **J8 Trade panel: PASS.**
  - A position-targeted 25% SELL is confirmed with no code and fills.
  - A deep link to a second-account position preselects that account. This failed first: a stale state read reset the account. It was fixed in the Platform Trade panel with a regression test.
  - A just-closed position says "no longer open" and sends nothing.
  - BUY asks for the code and retries with the same request id.
  - The Journal shows DRY RUN.
- **J11 Classic: PASS.** Registration with TOTP; bot create, edit and delete; halt and resume; pause and resume; Archive and Restore with risk and P&L unchanged; the API edge cases; Settings.
- **J12 `/bot`: PASS.** The opt-in, and Archive/Restore with the Overview figures unchanged.
- **J13: PASS.** Standard user 403s; dark, light and Classic at 1440 and 390 px; PWA metadata.
- **Push end to end:** three real DRY_RUN fills (2 SELL, 1 BUY) reached the `/bot` feed with the correct labels and no duplicates.
- **Not live-tested:** real browser or device push delivery (APNs/FCM), and native install. In the sandbox, egress is blocked and headless Chromium reports permission "denied"; device registration is covered by mocked DOM tests.

## 6. Open items (stated honestly)

- **Device push and native install are unverified.** Test on the real devices (iPhone Home Screen app, Android Chrome, desktop) after deploy, using a testnet DRY_RUN fill.
- **Advisories, no change made:**
  - An automation sweep's fill is labelled "Manual TP/SL exit".
  - Flipping `BINANCE_TESTNET` between reserving and sending an order on the env-credential route can mislabel that one fill. Account-backed routes are safe.
  - A shared browser keeps an admin's device subscription after sign-out (existing web-push behaviour).
  - The Platform event tables are never pruned.
  - The Archive flag list is copied, not shared, from `manualTrading.ts`. Keep them in sync when adding flags.
- **Not driven in the browser, covered by tests:** Shariah BUY refusal versus exit allowance, an unknown-outcome display, and a push-service outage.

## 7. Production checklist for Mahamid (unchanged in substance, still not done)

- [ ] Decide the fate of the **old `tradingbot` EC2**, which may hold real keys. Keep it stopped until then.
- [ ] **Rotate the historically leaked webhook secret.**
- [ ] **Off-server backup of `ENCRYPTION_KEY`/`SCRYPT_SALT`**, plus a scratch **restore drill**.
- [ ] **Reconcile the production migration drift** before running Platform 054 to 059.
- [ ] **Proxy rules:** `/api/manual-trading` from the Platform IP only (this now includes `/control/executions`); `/api/enroll` public per `deploy/ENROLLMENT.md`.
- [ ] **Admin 2FA** on before using the Bot controls.
- [ ] **An authorised testnet round trip** (`DRY_RUN=false`, testnet accounts only, operator present), including:
  - one push received on a real device;
  - one Archive/Restore.
- [ ] **No mainnet** until the owner authorises it.
- [ ] **Confirm deployed SHAs and flags** against this file and the six remote heads in the campaign `GIT_AND_CI_MANIFEST.md`.
