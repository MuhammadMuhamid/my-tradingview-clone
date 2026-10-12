# Trading Scene — Final Release Acceptance (2026-10-11)

Supervisor: Claude Opus 5.5 (final practical release closure). Independent reviewer: one fresh
Fable 5.1, read-only.
"Premium parity" here means material shared-workflow and interaction parity with TradingView
Premium, not exact pixels.

## 1. Git preflight

| Repo | Branch | Start HEAD | Remote at start | Notes |
|---|---|---|---|---|
| Platform | `finalization/mahamid-reconcile-premium-parity-20260918` | `c96a5a63f80446057e8f5bad0fe3b52ba2b40348` | equal | `origin/main` = `ca30f80`, an ancestor of HEAD (fast-forwardable). Working tree: 8 pre-existing tracked `graphify-out/` deletions and untracked `phase2/`, both preserved and never staged. |
| Research | `finalization/nonvisual-compute-delivery-20261011` | `2297cd67a209147953710d4d05de487662e69c0c` | equal | clean |
| Bot | `finalization/bot-halt-exits-20261011` | `88a8bfe1125d40f2c955c67c3d098393265d7501` | equal (`ls-remote`; no upstream configured locally) | clean |

No final-guide or acceptance files from interrupted attempts existed, so there was no partial work
to merge. No reset, clean, stash, rebase, force-push or history rewrite was used. Only explicit
paths were staged.

## 2. Objective visual / interaction review (Opus, live)

Runtime: project PostgreSQL (`platform/.pgdata`, :5433), backend `npm run dev` (:4000), frontend
`next dev` (:3000), Chrome via Playwright at 1440×900, with spot checks at 1024×768 and 1920×1080.
TradingView Premium was not opened. The surfaces were already re-measured against Premium in the
earlier waves, and the Premium regression lock re-checks the accepted geometry (§8).

Exercised, with results:
- **Chart:** initial load (BTCUSDT 1h, two study panes, Pine strategy); timeframe 1h→15m→1h;
  crosshair date/time label (`Sat 10 Oct '26 23:45`) and sticky vertical line across panes;
  price-axis drag changes the span and turns Auto off, and Auto restores it; chart context menu
  opens at the pointer; Reset view. Chart types: Candles → Range (tape, honest notice) →
  Volume footprint (cells on recent bars, honest notice) → Candles.
- **Drawings:** trendline create → select (per-tool floating toolbar: template, colour, width,
  style, settings, lock, delete, more) → move → Delete → ⌘Z restores → ⇧⌘Z removes.
- **Compare:** dialog search (Binance spot first), add ETHUSDT (pane, re-frame by design),
  survives reload, settings, hide/show, remove. **Defect FC-01 found and fixed** (§4).
- **Replay:** enter, pick bar, step +1 bar, play ≈1 bar/s with the chart moving, pause holds,
  studies follow the horizon, exit restores live.
- **Alerts:** price alert from the context menu and an RSI alert from the legend menu; both
  dialogs carry the evaluator-off notice (MA_ALERTS_ENABLED=false install), with timeframe
  chips and the condition explanation.
- **Responsive:** 1024 (toolbar folds into ⋯, legend compacts, no horizontal scroll), 1920 (no
  overflow).
- **Loading:** rapid SOLUSDT + 15m switch shows per-row `Loading…` and no foreign series, then
  the correct data.
- **Watchlist:** opened, add-search (FC-02, §4), panel closed again.
- **Runtime errors:** none from the app. Console noise is dev-only (React `eval()` notice under the
  dev CSP, the Next dev "1 Issue" badge) plus benign browser WebSocket close races on symbol
  switch.

## 3. Four inherited visual-queue dispositions

| # | Item | Disposition | Evidence |
|---|---|---|---|
| 1 | Study price-scale pill overlap (B-13) | **MINOR_COSMETIC** | Pills only collide when values are within a label height. The crosshair label correctly paints over pills, as on TradingView. The legend always shows the exact value. The lock's "no tick label half-covered by a pill (8 zoom states)" passes. |
| 2 | Pine Style / Visibility customisation | **NEW_SCOPE** | The Pine study settings dialog offers only an *Inputs* tab. No fake Style/Visibility tabs suggest unavailable customisation. Built-in studies (RSI, ATR…) have Inputs/Style/Visibility. Per-plot Pine overrides would be a feature expansion and are not a release blocker. |
| 3 | Vertical crosshair time lock ("Lock vertical cursor line by time") | **NEW_SCOPE** | Absent from the chart, time-axis and settings menus. No dead control implies it. Replay and time-state behave correctly. |
| 4 | Loading transient presentation | **INTENTIONAL** | Rapid symbol + timeframe switch shows `loading…` on the title and `Loading…` per study row over an empty plot, never a stale or foreign series. Data then lands correctly. |

## 4. Material defects found and fixed this closure

| ID | Found by | Defect | Fix | Proof |
|---|---|---|---|---|
| **FC-01** | Opus live | The Compare pane's legend **Remove / Settings / Hide** (and the pane ⋯ *Delete pane*) did nothing. The comparison is pane state, but `ChartPane.paneAction` handed its `compare:…` key to the Pine indicator API, which ignored it. Second defect exposed while fixing: `setPaneCompare` upper-cased a restored canonical id (`instrument:v1:…:spot` → `INSTRUMENT:V1:…:SPOT`), so any write-back (mode change, eye) changed the key, refetched and re-framed the chart. | `c4c31dd`: verbs route to the pane's compare record (Remove clears it, Settings opens the chip's menu, Hide sets a persisted optional `hidden` flag with Show/Remove on the price legend). Canonical ids stay canonical; chosen tickers are stored as before. | DOM `compareLegendVerbs.test.tsx` (red on old source, green now), 2 unit tests in `compare.test.ts`, related compare/legend/restore suites 39/39. Live: verbs work, hidden state survives reload, visible range preserved after reload → hide. |
| **FC-02** | Fable review (M-1), confirmed by Opus | The watchlist **add-symbol search never showed results** in the dev runtime. The `live` flag was cleared by effect cleanup and never set again; React StrictMode (on in `next.config`) double-mounts in dev, so every answer was discarded ("Searching…" forever, Enter added nothing). | `8393faa`: flag set on mount. | DOM `watchlistAddStrictMode.test.tsx` (red on old file, green now). Live: "eth" lists ETHUSDT, ETHUSDC, … No other file uses the pattern (grep). |

Both commits were pushed to the campaign branch.

## 5. Cosmetic differences and findings deliberately accepted

- **Fable M-2, watchlist ticker hard-clip at the default 300px panel (`SOLUSD…`): INTENTIONAL.**
  This is the measured parity decision TVP8 F-01: TradingView at a 300px panel shows `BTCUSI`,
  `ETHUSI`, `DASHU`, truncating the ticker and never a number. The widths are pinned by
  `tests/uiContract.test.ts`, the row's tooltip carries the full name, and the panel resizes to
  420px.
- Price-alert dialog seeds 8 significant digits (`80547.887`) while the menu label shows
  2 decimals: minor; the field is editable.
- Adding a comparison and switching chart type re-frame the time axis: intentional (documented in
  code).
- Self-comparison is accepted, with a warning in the compare menu. Switching the chart to the
  compared symbol drops the comparison (F-09). Minor.
- From the Fable minor list (accepted, not release-blocking): right-click on an indicator title
  opens the legend display menu (hover verbs and ⋯ cover indicator actions); indicator add/remove
  is not on the undo stack (drawings are); a pill can show the last-visible-bar value after a
  pan; at 1024×768 with the Pine panel open the RSI pane is about 24px tall; adjacent pane axis
  labels can touch; 0-entry window rows show `+0.00%`; long select texts truncate
  (`…SPOT`, `Price reaches the lev…`); the stress form does not prefill the strategy block when
  opened from a run; the Price & trades chart opens on the latest bars; `/screener` shows a
  clean "Scanner service unavailable" (503) in this environment.

## 6. Historically fragile paths (bounded regression)

All held: Range chart (tape + notice); Footprint without tape history (candles + notice); Pine
strategy on chart (canonical "1 on chart"); Compare add/remove/settings (FC-01 fixed); Replay
chart movement, replay studies, replay picker, replay exit; context menu opens at the pointer;
toolbar overflow at 1024; hydration/state restoration across reloads (compare, hidden compare,
studies, drawings); alert price prefill matches the pointer price; gate creation persistence and
no gate leakage (Fable: alert dialogs open/cancel cleanly; engineering tests `alertEdit`,
`maAlertBulkEdit`); price-axis drag; crosshair date/time; pane collapse/expand/maximize (Fable);
layout selector (Fable, inspected); legend controls; watchlist live during replay (B-05, lock);
multi-chart symbol sync default off (B-09, unchanged).

## 7. Representative product workflows (live)

- **Backtester:** `/research` → MA + R:R, SOLUSDT 5m, 1 month, capital 1,000, 0.1 %,
  2 ticks → queued → done. The result page shows headline, three windows with the "not withheld"
  explanation, run settings, engine `v2-corrected` with the correction list, and the
  **fee-inclusive skip message**: *"This run could not have taken 2237 of its entries. Each would
  have spent 931 while the account held less — 930.86 at the first…"* (MONEY-FEE visible).
- **Stress:** *Stress this run* → BTCUSDT 1d worst return → 3 windows, each with *qualified by
  return −34.20 %* etc., "chosen from market data alone" → run → per-window results, hindsight
  note, discovery parameters stored for reproduction.
- **Shariah:** Status and Screening tabs. Counts correct (9 active, 0 eligible, 9 review). The
  asset panel shows UNSCREENED → effective REVIEW, evidence required, nothing preselected,
  append-only history. *Check results* with deliberately incomplete JSON → "Nothing was
  published" plus precise per-field errors. Nothing was published, and Mode stayed OFF.
- **Compute Helper:** an isolated loopback instance (temp root, port 8899, no coordinator).
  Helping ON → `connectionState: offline`, capacity 0, "no coordinator is configured" (no claimed
  connection); OFF → unchanged truthfully. A cross-origin POST was refused `403`. Instance
  stopped. Focused Research suites run now: `test_backtester_compute_helper` **37/37**,
  `compute_helper_ui.test.mjs` **16/16**.

## 8. Final authoritative validation (Platform, after the last code change `8393faa`)

| Suite | Result |
|---|---|
| Backend lint (`eslint --max-warnings=0`) | pass |
| Backend typecheck (src + scripts + tests) | pass |
| Backend full suite (`npm test`, real PostgreSQL test DB) | **1384 / 1384**, 0 fail, 0 skipped |
| Backend production build (`tsc`) | pass |
| Frontend lint | pass |
| Frontend typecheck | pass |
| Frontend unit (`npm run test:unit`) | **1524 / 1524** (1522 inherited + 2 new) |
| Frontend DOM (`npm run test:dom`) | **577 / 577** (574 inherited + 3 new) |
| Frontend production build (`next build`) | pass |
| **Premium regression lock** (`qa/premiumLock.mjs`, production build on :3051 → backend :4000, installed Chrome) | **61 / 61**, lock file unchanged |
| Platform docs check (`scripts/ci/check_docs.py`) | clean |

The backend source is unchanged since the accepted engineering closure, and its suite ran once in
this closure. No test or lock assertion was weakened.

## 9. Engineering contracts preserved

Fee-inclusive affordability; impossible slipped-fill rejection; financial input validation incl.
type enforcement; Stress settings/storage and atomic coordinator creation; alert edit fail-closed;
Shariah exits available during screening outage; Shariah import concurrency protection; Pine
engine quarantine; Helper durable delivery, ownership, presence, repoint and revoked-storage
retention. No engine, backend, Research or Bot source changed in this closure. The two fixes are
frontend-only (chart compare verbs, watchlist add box).

## 10. Fable final review

`FABLE_FINAL_REVIEW=COMPLETED`: one fresh read-only Fable 5.1 reviewer, about 14 minutes of use
on the dev runtime. Verdict as reported: NOT_READY on M-1 and M-2. Opus adjudication: **M-1
confirmed MATERIAL → fixed (FC-02); M-2 INTENTIONAL (contract F-01)**. Minors are accepted in §5.
The reviewer also independently re-verified the FC-01 fix including the reload persistence, and
confirmed owner chart state was restored.

## 11. Research and Bot

- **Research:** `finalization/nonvisual-compute-delivery-20261011` @ `2297cd67…`, clean,
  local == remote; `main` `f6d10e5` unchanged. **Inherited evidence:** 224/224 Python,
  101/101 Node (nonvisual closure). New this closure: focused helper suites 37/37 and 16/16.
- **Bot:** `finalization/bot-halt-exits-20261011` @ `88a8bfe1…`, clean, local == remote;
  `main` `9286434` unchanged. **Inherited evidence:** 385/385 backend, 13/13 frontend.
- Neither repository was modified or promoted. They remain handoff branches.

## 12. Migration 047

`047_fractional_backtest_slippage.sql` is recorded on the canonical dev database
(`schema_migrations`, 2026-10-11 17:18), and both `slippage_ticks` columns are `numeric`.
**External action:** every other deployment target must apply it through the normal runner
(`npm run migrate` in `platform/backend`) when separately authorised. Nothing in this closure
touched any non-local database.

## 13. Workspace cleanup

Disk free at start 16 GiB. The dev servers and builds consumed space during the session; free
after cleanup is 14 GiB.

| Action | Detail |
|---|---|
| Stale worktree metadata pruned | Research `researchfix` and Bot `botfix` registrations, both pointing at a deleted temp scratchpad (`git worktree prune`). Their commits are on the remotes (`finalization/compute-helper-20261011` @ `894e733`, `finalization/bot-halt-exits-20261011` @ `88a8bfe`). |
| Redundant local branches deleted | 9 Platform `worktree-agent-*` fixer branches whose every patch is in the campaign branch (`git cherry` 0 unique). 11 others with patch-distinct commits were **kept**. |
| Stale builds removed | `platform/frontend/.next/dev` (438 MB) and `.next/cache` (86 MB). The production build is kept (78 MB). |
| Generated clutter removed | `platform/.playwright-mcp/` (684 MCP captures, 43 MB, gitignored; curated captures had been copied out per `TRADING_SCENE_BROWSER_PARITY.md`); 9 gitignored, unreferenced root PNGs; this session's MCP console/page logs; this session's `final-closure/` screenshots. |
| Duplicate removed | `Trading-Codex-V3/TradingView-Parity-Post-TVP5-Sonnet-S1-20260912/`: byte-identical (`diff -rq`) to its ZIP, which is kept. |
| Docs archived | `docs/HANDOFF-2026-09-18.md` and `docs/HANDOFF-2026-09-18-premium-parity.md` → `docs/archive/` (superseded "final" handoffs; no code/test/CI references). README documentation table updated; `check_docs.py` clean. (The two pure renames were already staged when `8393faa` was committed and landed in that commit; no content changed, and history was not rewritten to separate them.) |
| Folders reorganised | 39 historical top-level items of `Trading-Codex-V3/` plus `v2-campaign/CURRENT_PROJECT_MAP.md` (stale: named an old active branch), `expansion-chain-pack/`, `final-hardening/` → `Trading-Codex-V3/archive/campaign-history-2026-08-to-09/` by same-disk rename, with file-count and byte totals verified per item. The manifest and old→new mapping are in that folder's `README.md`. A new `Trading-Codex-V3/README.md` explains the layout. |
| Deliberately retained | `v2-campaign/runtime/` and `state/` (secrets, data), `logs/`, `evidence/`; `phase2/` (protected); `TradingView-Parity-TVP8-20260913/` (output root in tracked `.mcp.json`); `TRADING_SCENE_V2_AUTONOMOUS_CAMPAIGN_REVIEWED/` and `TRADING_SCENE_V2_SIMPLE_RCODEX_CHAIN/` (targets of registered LaunchAgents); tracked user Pine strategy files at the Platform root; `/Users/m/Documents/Trading-Scene-Archive` (unique recovery/context material); all protected paths listed in the brief. |
| LaunchAgents | `com.tradingscene.v2campaign` and `com.tradingscene.v2simplechain` (KeepAlive only while a `state/WANT_*` marker exists; none does) and `com.tradingscene.tvp5.rcodex.finalreviewed` (RunAtLoad/KeepAlive false) are registered, dormant and not running. Their targets were left in place, so no automation was broken. Retiring them is an owner decision (`launchctl bootout gui/$(id -u) <plist>`). |

## 14. Main promotion and external actions

Platform `main` is promoted by **fast-forward only** to the campaign HEAD that contains this
report. The fast-forward safety proof and the final `local main == origin/main == release SHA`
equality are recorded in the campaign ledger and the final review package (this file cannot
contain its own commit's SHA). Research and Bot `main` are **not** promoted. External actions
for the owner: apply migration 047 to other deployments when authorised; decide whether to
retire the dormant LaunchAgents; decide on Research/Bot promotion.

## 15. Verdict

No material blocker remains. The practical visual and interaction acceptance passed after two
small frontend fixes. Engineering contracts are intact, final validation is green, the Premium
lock is 61/61, documentation is complete, and cleanup is done.

`FINAL_RELEASE_READY=YES`
