# Trading Scene — full engineering and product handoff for Mahamid

**Prepared:** November 2, 2026  
**Prepared by:** ChatGPT, using the available V2/V3/V4 campaign records, the V4 independent release review, and the owner's subsequent V4-polish completion report.  
**Audience:** Mahamid (technical collaborator / product acceptance reviewer).  
**Verified:** 2026-11-02 by Claude Code against the local checkouts, the campaign evidence on the owner's SSD and the live GitHub repositories (see *Verification record* at the end). The verified copy is this file; the owner's original is kept outside Git.  
**Status boundary (updated 2026-11-02 after synchronization):** Platform PR #1 and Research PR #1 were merged into the owner's `main` branches on 2026-11-02 with ordinary merge commits (no squash, no rebase, no force). Main-branch GitHub CI passed on both. Mahamid's Research `main` was fast-forwarded to the same commit. Mahamid's Bot `main` already matched. **Mahamid's Platform `main` was deliberately not updated** because that repository is public and the owner's synchronization rules stop at a public remote; it remains an ancestor of the canonical commit with no independent work. The exact `main` SHAs live in the owner's external sync record (`Trading-Scene-Campaign/V4-Release-Polish/MAIN_SYNC_RECORD_2026-11-02.md`) and on GitHub; `main` may advance past the merge commits named below by later documentation-only commits.

> **Read this first:** Trading Scene is materially more functional, secure, and intelligible than it was before the November campaigns. Substantial defects were fixed and verified locally. Nevertheless, it is **not independently certified for real-money trading**, actual Google OAuth, or Bot-connected Shariah enforcement. Your most valuable contribution now is hands-on product acceptance, integration testing under realistic conditions, and deciding a small set of product policies—not another generalized rewrite.

## 1. What this project is and where the software lives

Trading Scene is an advanced charting, analytics, discretionary-trading, strategy-testing, and research system, split across three repositories:

| Area | Responsibility | Local checkout |
|---|---|---|
| **Platform** | TradingView-style chart workstation, symbols/candles, accounts, watchlists, alerts, screener, admin manual-trading UI, Shariah console, Journal, Quick Backtest, platform Stress | `/Volumes/TradingSceneDev/Trading-Scene-Work/platform` |
| **Research** | Optimizer Search, Stress, Walk-forward, Holdout, Backtester runs, Compute Helper coordinator/results | `/Volumes/TradingSceneDev/Trading-Scene-Work/research` |
| **Bot** | Privileged trade execution and exchange integrations; keys should remain in the Bot boundary | `/Volumes/TradingSceneDev/Trading-Scene-Work/bot` |

**Architecture principle:** Platform decides → Research consumes → Bot executes. A passed chart/backtest test is not evidence that an exchange order or Bot enforcement works.

Repository mapping, with visibility as read from the GitHub API on 2026-11-02 (visibility is an owner setting and can change; re-check before relying on it):

| | Owner's GitHub (`2ms-muzammil`) | Mahamid GitHub (`MuhammadMuhamid`) |
|---|---|---|
| Platform | `trading-scene-platform` (private) | `my-tradingview-clone` (**public** — deliberately, so the AWS CloudShell deploy can fetch a commit archive; see `docs/OPERATIONS.md` §9) |
| Research | `trading-scene-research` (private) | `pythoncryptobacktesingsystems` (private) |
| Bot | `trading-scene-bot` (private) | `3commabotclone` (**public**; the Bot guide's header still says "private" — left as is, see Verification record) |

Private repositories may require authentication to open. The Git synchronization goal is **exactly matching full `main` commit hashes and trees** for each corresponding repository, not merely similar-looking code. Check that Mahamid's `main` had no independent commits before fast-forwarding; never overwrite his work.

### Most recent known source checkpoints

- **Platform accepted V4+polish feature tip:** `44414901fa37` (code commit `303acd1`; tip described as owner-guide documentation only).
- **Research accepted V4+polish feature tip:** `69ed83b082c2` (reported documentation-only tip).
- **Bot:** `76d17c5a7732` (unchanged in V3/V4/polish).
- **Owner's reported GitHub draft PRs, with green CI at handoff:** `https://github.com/2ms-muzammil/trading-scene-platform/pull/1` and `https://github.com/2ms-muzammil/trading-scene-research/pull/1`.

These are the **feature-branch tips** that were reviewed and tested. They are preserved on the owner's GitHub as `experience/v4-20261102` in both repositories.

### Merged release commits (2026-11-02)

Commit ids are abbreviated to 12 characters here (the repository's secret scan rejects 40-character hex runs); the full ids are in the owner's external sync record and on GitHub.

- **Platform:** PR #1 merged as merge commit `0b75905a1255` (parents `b00dc26` and `4441490`; its file tree is byte-identical to `4441490`).
- **Research:** PR #1 merged as merge commit `2578f813c711` (parents `44f8da8` and `69ed83b`; tree identical to `69ed83b`).
- **Bot:** `76d17c5a7732`, unchanged.

These merge commits are immutable facts, but `main` is not frozen at them: documentation-only commits (such as the one that adds this file) may follow. Always read the current tip from GitHub.

## 2. What the owner and Claude accomplished

This was a series of bounded campaigns, each building on preserved work. It was not a complete replacement of the original application.

### V2 — broad product-engineering and integration campaign (November 1)

The Platform/Research/Bot architecture and the many advanced user-facing features were inspected and exercised locally. This established a baseline for a chart-focused workstation with account-aware experiences, Shariah review, manual-trading architecture, Journal, Quick Backtester and Research tools. Local simulations/fixtures covered parts of account isolation, stress studies, optimization, and helper exchange. Several important correctness and usability deficiencies remained, prompting V3.

**Important:** V2 was not a production certification. There was no demonstrated live exchange trading, real Google OAuth completion, or two-computer Compute Helper validation.

### V3 — correctness closeout (November 1–2)

V3 attacked specific problems discovered by an independent source/evidence review:

1. **Market-history admission:** bound ordinary-user deep candle requests to 200,000 *source* bars and bounded concurrent cache-bypassing history requests; expose when returned coverage is truncated. This protects against previously unbounded user-triggered provider work. It is still a potentially expensive operation and some privileged deep requests remain less constrained.
2. **Symbol registration during provider outages:** avoid guessing/caching unconfirmed Binance instruments; distinguish genuinely unknown symbols from unavailable upstream metadata; isolate a bad/delisted row so it doesn't spoil an entire metadata batch.
3. **Candle completeness:** report missing leading/interior/trailing bars instead of treating an almost-complete provider fetch as complete; improve Research historical-data preflight.
4. **Role-aware UI:** remove the initial flash of admin controls for Standard users or while roles are loading.
5. **Optimizer results:** fix exported best-candidate parameter names (previously `{"undefined": true}` in affected trees); test the actual generated parameters.
6. **Compute Helper trust:** extend code-fingerprint coverage and validate a meaningful synthetic replay with **16 nonzero completed trades**, matching local and helper output byte-for-byte on one Mac.

V3's saved tests passed, but two major product gaps remained: **Stress could mislead when a selected period crossed missing candles**, and a fully accepted distributed job could still remain stuck in `created` rather than becoming a completed Research run.

### V4 — first-use Shariah, coherent UX, trustworthy Stress, complete distributed results (November 2)

V4 deliberately used separate browser evaluators *before and after* UI edits, and independent code reviewers.

**A. A real Shariah authorization defect was found and repaired.** With accounts enabled, the publication/import/snapshot write routes checked a legacy admin-cookie format, but modern accounts used another token format. Even a valid administrator received HTTP **401**. The correction uses the session/role the backend gate has already authenticated and derives the audit actor from the server rather than form input; a review checked that Standard users still cannot write. Saved pre-fix 401 versus after-fix 201 proof exists.

**B. First-time Shariah journey was made understandable and tested in real browsers.** A fresh evaluator worked through an empty universe, asset sync and selection, research-pack export, invalid/valid JSON results, review and publication, per-asset publishing, refresh/sign-out persistence, Mode ON/OFF, and Standard-user read-only behavior. Improvements included clearer labels, meaningful errors, a publication confirmation, first-use cues, and the **Bot floor 'not armed'** state remaining truthful after reload. **These were fixture classifications, not authoritative Islamic rulings.**

**C. Stress now labels data quality *per window*.** It records missing bars, expected versus actual elapsed time, affected ranges, and states **Complete / Impaired / Not comparable / Not verified**. A test gap of six one-hour candles produced an explicit 'Not comparable' UI warning; clean windows showed 'Complete'. A separate V3 regression breaking Research's 'Find difficult periods' discovery was fixed. Importantly, the current product *discloses and still permits* some gap-spanning studies instead of refusing them: that remains a policy decision.

**D. Compute Helper can finish the real Research lifecycle.** After all valid work is accepted, results are revalidated, final artifacts are written, the run becomes **Completed**, and a controller restart can reconcile a previously stuck run. Partial/rejected work does not complete. The old stuck example was repaired; same-Mac helper-vs-local replay remained identical over 16 trades. **This is not two-physical-Mac validation.**

**E. Main-chart visual consistency and permissions.** The chart is the authority for colors, spacing, controls and visual vocabulary. Internal Shariah, Journal, Alerts, Screener, Profile, Onboarding and related pages were compared using browser screenshots. Role-aware navigation, clearer errors, chart-linked pages and disabled-manual-trading states were improved. The original 16-item matrix should be quoted as **10 fixed / 2 partial / 4 left out of scope**, not the inconsistent summary '11 fixed / 2 partial / 4'.

V4's recorded final suite results before the extra polish were **4,171 passing tests** (Platform backend 1,499; frontend unit 1,589; DOM 665; Research Python 262; Node 127; TypeScript 29), plus successful typechecks and production build. These are reported/log-backed results, not independent reruns on Mahamid's hardware.

### Final V4 polish and Git preflight (November 2)

After an independent offline release-gate review, a narrow polish pass addressed remaining issues before publishing branches:

- **Failed account/session read in the chart product menu:** explicit inability-to-check-account message, keyboard-accessible Retry, and Sign out; no admin controls while unreadable. Reviewer identified a keyboard focus regression on Retry, which was corrected before commit.
- **Phone-width Alerts:** at approximately **390px**, a long symbol such as `SOLUSDT` no longer clips; the title, symbol field and desktop geometry were checked in a browser.
- **Research link:** clarified that `127.0.0.1:8765` opens Research only on the computer running it; retained loopback binding instead of exposing an unauthenticated local service.
- **CI blocker:** eliminated three TypeScript `any` uses in a V4 Stress test using the existing typed StressWindow contract, satisfying backend lint's zero-warning rule.
- **Research release formats:** investigated the new distributed result files and **intentionally made no code change**. They are immutable output artifacts, not persisted input schemas; registering them would unnecessarily damage rollback compatibility with pre-V4 code. The rationale was documented.
- **Docs:** updated owner guide/UI-UX contract/Research controller documentation and corrected the historical 16-item count in the *new* reporting (not by rewriting original evidence).

**Final polish tests as reported:** Platform backend **1,499**, frontend unit **1,590**, frontend DOM **671**, Research Python **262**, Node **127**, TypeScript **29** = **4,178** passing checks; typechecks, lint, build and both GitHub CI pipelines reportedly green. One backend run crashed natively when run concurrently with the DOM suite; an isolated full rerun passed and the failed log was preserved. This is worth monitoring if recurrent.

**Git state after synchronization (2026-11-02):** both PRs are merged into the owner's `main` (see *Merged release commits* above) with main-branch CI green; Research is identical on both accounts; Bot is identical on both accounts; Mahamid's Platform `main` is still the pre-campaign commit `b00dc26` because the repository is public (owner decision pending). Nothing was deployed: the AWS deployment described in `docs/OPERATIONS.md` §4 and §9 is a manual operator step, and no GitHub workflow, webhook, environment or deployment integration triggers it.

## 3. What the product actually lets users do

Do not assume all signed-in users can access all advanced tools.

| Feature | Current intended scope | Important reality check |
|---|---|---|
| Chart workstation | Standard and admin | TradingView-style candles, themes/layouts, drawings, strategies/Pine-like tools, watchlists, alerts; deeper feed coverage limits remain |
| Screener | Generally navigable, backend/service dependent | Separate Python scanner; reported Binance HTTP 451 in the test environment; not live-demonstrated there |
| Shariah | **Admin manages; Standard reads decisions** | Tracked Binance Spot **USDT-quoted trading-pair base assets**, external human/AI-supported review pack → JSON validation → human approval → publish → Mode; not an automatic religious ruling |
| Journal | **Admin-only** | The Journal page is wrapped in the administrator-only page guard; a Standard account sees the admin-only notice, not a personal journal (`docs/TRADING_SCENE_OWNER_GUIDE.md` §5) |
| Manual trading | **Admin-only** | Market/Limit BUY/SELL through Bot-controlled exchange integration; optional TP/SL is Bot-managed/polling, not exchange-native guaranteed protective orders; no verified real order |
| Quick Backtester | **Admin-only** | Three strategy families (`ma_rr_v9`, `srtrend_v10`, `mtf_lean`); symbol/date/timeframe/sizing/cost assumptions; specific local demo was completed |
| Research Optimizer | **Admin-only** | Search, Stress, Walk-forward, Holdout; best-candidate export fixed; real-data WF/Holdout economic value not established |
| Compute Helper | Operator/admin research workflow | Supported distributed work includes constrained replay; jobs now finalize, but no physical second Mac demo |
| Bot | Privileged execution system | Keep keys, execution policy, Shariah Bot-floor and live/3Commas verification separate from chart/login tests |

**Product-scope decision required:** If the goal is *every signed-in user connecting their own exchange account and trading with a private Journal*, that is **not** what this implementation currently guarantees. This is a new feature/product design decision, not something the V4 fixes silently delivered.

## 4. How to review the actual evidence

The owner's Mac/SSD is the authoritative workspace for saved local campaign artifacts. Ask for copies of the documents/logs or an archived handoff if not using that machine.

- V3: `/Volumes/TradingSceneDev/Trading-Scene-Campaign/Closeout-V3/FINAL_CLOSEOUT_REPORT.md` and the independent V3 technical review.
- V4: `/Volumes/TradingSceneDev/Trading-Scene-Campaign/Experience-Finish-V4/FINAL_REPORT.md`, `SHARIAH_FIRST_USE.md`, before/after friction ledgers, `CHART_UI_CONSISTENCY.md`, screenshots, reviews and final test logs.
- Final polish: `/Volumes/TradingSceneDev/Trading-Scene-Campaign/V4-Release-Polish/FINAL_POLISH_REPORT.md`, `FIX_LEDGER.md`, `evidence/` logs, browser measurements, screenshots, review and GitHub push records.
- Platform current-use manual: `platform/docs/TRADING_SCENE_OWNER_GUIDE.md`. For interface intent: `platform/docs/TRADING_SCENE_UI_UX_CONTRACT.md`; for research internals: `research/docs/BACKTESTER-CONTROLLER.md`.
- Independent offline V4 review: `Trading_Scene_V4_Independent_Release_Gate_Review.md` is the owner's external review document (produced from a zipped copy of the V4 package); it is **not** stored on the owner's SSD or in Git — ask the owner for it. The earlier independent-review package for V2 is at `Trading-Scene-Campaign/Independent-Review-Handoff/` (`START_HERE.md` plus two checksummed archives). Both reviewers checked supplied packages, not the live production instance.

**Evidence-strength hierarchy:** production/testnet integration with real infrastructure > firsthand local browser path and saved DB result > successful full code tests/builds > source inspection > screenshots without interactions > implementer's summary. None of the above establishes profitable strategy performance.

## 5. Mahamid's hands-on acceptance checklist

Use a **disposable local database/accounts and test fixtures**, not production accounts, private exchange keys, actual trade execution or unreviewed Shariah rulings. For each failure, record the page, identity/role, action, expected versus observed result, screenshot, and console/network error if available. Avoid letting an agent 'fix' a confusing product interaction before you see it yourself.

### A. First impression, visual consistency and navigation

- Launch the local Platform and look first at the **main chart**; treat it as the reference design. Move among Chart, Shariah, Journal, Screener, Alerts, Backtester, Research and settings in **dark and light themes**. Are typography, spacing, buttons, page titles and feedback consistent? Which pages feel alien or unexpectedly dense?
- Repeat key routes at a 390px phone width and at desktop size. Check clipping, horizontal scroll, active tabs, long tickers and whether buttons remain reachable. Check basic keyboard focus/Retry.
- Test **admin, Standard, signed-out and temporarily unreachable backend**. Standard users must not see admin-write controls or routes presented as usable. A failed `/api/auth/me` should display a neutral error and Retry, never grant admin-looking access. The owner-supplied polish report says this is fixed in the chart menu; confirm it yourself.

### B. Shariah — highest-value owner journey

- From an **empty test universe**, discover **Sync universe**, understand what is tracked, and choose due/selected assets. Can you explain 'needs attention' versus 'needs review' without guessing?
- **Export a review pack.** Check that the JSON contains asset identity, questions/interpretation guidance, required response keys, and that the next step is unambiguous. External research is a **separate step**; do not assume ChatGPT or the software gives a definitive Shariah ruling.
- **Import a deliberately malformed file** and then a correctly formed *fixture*. Check that the error is actionable, reviewed decisions are shown, and publishing requires deliberate confirmation. Refresh, sign out/in and check published entries remain.
- Switch **Mode ON/OFF** in the disposable installation. Can you clearly distinguish 'Platform Mode ON' from **'Bot control channel not armed'**? Do not interpret ON as proof an independent Bot webhook rejects BUY orders.
- Sign in as Standard. Shariah should be **read-only** with an understandable explanation; attempt unauthorized write routes with test credentials in a controlled environment and confirm denial.
- Note remaining small UX issues from V4: dense 11–12px text, a filter that can hide newly published entries, persistent selections, a narrow-screen mode chip moved below the tab strip, and similar 'attention/review' controls. Change only if they genuinely impede you.

### C. Chart, history, alerts, screener and trading UI

- Open a busy chart with multiple panels and historical data. Look for honest 'truncated/missing' coverage instead of assumed completeness; large/deep fetches may be slow, bounded, or rate limited.
- Create/modify a disposable alert and check the symbol field on mobile; confirm it does not clip. Check retries, invalid symbol feedback, and that one denied backend request doesn't result in misleading success.
- Try Screener with its service stopped and then, when genuinely available, started. The previous local network returned **HTTP 451** to Binance; this was an environment/provider restriction, not proof the product is inherently broken.
- Inspect **Manual Trading** setup and the Journal together. Does the UI explain who can trade, where the Bot keys live, what the connection state means, and why there may be no entries? Never submit a real order as part of this acceptance. If safe testnet is later configured, separate that as an explicit stage.

### D. Backtesting and Research credibility

- Run Quick Backtest on known, complete local history. Inspect symbol/timeframe, capital, commission, slippage, sizing, holdout window, fills and trade count. Confirm there is actual economic activity before trusting returns.
- Run/inspect an Optimizer Search and the **Stress** period picker. Compare a clean period and a deliberately gap-impaired local period. The UI must show **Complete / Impaired / Not comparable** and legacy **Not verified** appropriately. Confirm *the Research saved Stress table* displays those warnings; V4 covered that table in automated tests, not an end-to-end browser study.
- Inspect Walk-forward and Holdout. The prior synthetic smoke tests produced **zero trades** with shipped sizing assumptions (e.g., $1,000 initial capital and $1,000 fixed entry). Do not mistake a successful job state for a validated profitable strategy. Try a correctly sized, nonzero-trade real-data experiment before calling the engine economically useful.
- Determine whether allowing an 'Impaired' or 'Not comparable' window to execute is acceptable as a research warning or should be an error. That is a **product policy** choice; don't silently change it in code.

### E. Compute Helper and Bot integration

- Open a completed distributed Research run and find its final result artifacts, candidate metrics, trade/equity output and completion status. Test recovery after a controller restart on a disposable run if feasible. Do not call 'accepted 1/1' equivalent to completed unless result verification/finalization also succeeded.
- If a **second Mac** is available, conduct a separate real-network pairing/transport/fingerprint and result-parity test. The saved 16-trade proof was *same-Mac*, not a second physical machine.
- Later, with explicit authorization and testnet-only credentials, test the **actual** Bot/Shariah enforcement boundary, including BUY refusal on disallowed assets and the handling of direct Bot/webhook paths. Confirm how TP/SL is managed, what happens if the Bot disconnects, and whether emergency stops work. No unattended production trading.

## 6. Decisions Mahamid should discuss with the owner (do not auto-implement)

| Decision | Current behavior | Why it matters |
|---|---|---|
| **Who can trade?** | Admin-only manual orders/Journal/Research; Standard mainly charts, alerts, view-only policy | Is Trading Scene owner/operator software or a general multi-user trading product? |
| **Shariah Mode without Bot floor** | Platform Mode can be ON while Bot channel is 'not armed' | Decide whether to refuse activation or keep explicitly distinct states; don't claim system-wide enforcement today |
| **Stress with missing candles** | Studies can run with warnings; two-or-more missing bar slots classified not comparable in V4; one slot impaired | Research policy for refusing, filling or disclosing incomplete data |
| **Blocked distributed run** | Results that fail re-verification remain blocked; clone/redo may be needed | Is a safe, explicit reopen action worth implementing? |
| **Data coverage/preflight limits** | Main chart history and selected primary timeframe assessed; not every warm-up/HTF/auxiliary feed | Whether to require stronger multi-feed coverage guarantees before trusting strategies |
| **External research quality** | Shariah JSON shape/provenance checked; content truth and ruling quality not established | Who owns methodology, sign-off, evidence freshness, and dispute/review workflow? |
| **UI residual preferences** | Some Shariah mobile/text and Research layout details remain | Prioritize only after a real person finds them costly/confusing |

## 7. Specific risks and anomalies to watch

1. **Git parity and privacy:** After the planned sync, confirm exact full `main` SHAs match on both accounts for Platform, Research and Bot; Mahamid's unrelated history must not be overwritten. Check repository visibility and *external deployment integrations*, not just GitHub Actions workflows.
2. **Live deployment is a separate event:** A merged branch does **not** mean Netlify/Vercel/Render/other providers weren't configured elsewhere to deploy automatically. Verify integrations before a production-facing main merge. No such production deployment was demonstrated in the supplied V4 campaign. *Verified 2026-11-02:* all six repositories have CI-only workflows (lint, typecheck, tests, build, hygiene), no GitHub deployments, environments or webhooks visible to the owner's token, and no Vercel/Netlify/Fly/Render configuration in the trees. The AWS stack is deployed by hand (`docs/OPERATIONS.md` §4, §9).
3. **Auth regression:** the Shariah 401 occurred because a new accounts design and a legacy internal auth check diverged. Watch any other legacy handler that rechecks cookies independently rather than using the resolved server account; do not weaken route/role gates.
4. **Research loopback:** `127.0.0.1:8765` refers to the *current* machine. Opening that link on Mahamid's laptop will not reach an instance running on the owner's Mac, and it must not be exposed publicly without a separately designed security boundary.
5. **Historical-data economics:** no proof of real-money strategy quality; missing candles, warm-up gaps, costs, sizing and zero-trade runs can invalidate seemingly impressive results.
6. **CI/native-crash uncertainty:** a backend native Pine worker crash was seen only during concurrent heavy test execution; isolated backend rerun and GitHub CI reportedly passed. Repeated native failures need diagnosis, not silent dismissal.
7. **Release/rollback compatibility:** new distributed result files were intentionally left out of the Research release-format registry as output-only artifacts; don't register/bump formats without verifying backward compatibility and old-run behavior.
8. **Old cache relocation:** during V4, four unrelated `/private/tmp` directories were moved onto the external SSD and symlinks left behind due to extremely low internal disk space. Do not delete the relocated data or symlinks without verifying who still depends on them.
9. **Operator-managed protections:** Bot-managed polling TP/SL is not equivalent to an exchange-resident protective order. Lost network/Bot availability matters. Do not imply automatic failsafe coverage without integration proof.

## 8. What successful acceptance looks like

The goal is *not* to find zero cosmetic imperfections. It is to be able to say, using firsthand observations:

- Shariah's main workflow is clear, functions with proper authorization, persists results, and **never implies Bot enforcement when the Bot isn't armed**.
- Standard versus admin screens are consistent, and session failures can be recovered without incorrect permissions.
- The main chart, Alerts, Journal, manual-trading setup and internal Research pages feel like one recognizable product; genuinely confusing steps are recorded.
- Stress clearly distinguishes good history from impaired/non-comparable or old unverified results.
- A distributed run displays final results, not just accepted work; no claim has been made about two-Mac operation until tested.
- All repository copies and documentation describe the same actual build and main-branch history.
- Nobody treated passing local tests as permission to use real exchange funds.

**Suggested feedback template** (one entry per issue):

```text
AREA / PAGE:
ACCOUNT / ROLE / DEVICE:
STEPS I TOOK:
WHAT I EXPECTED:
WHAT ACTUALLY HAPPENED:
SEVERITY: blocker / confusing / cosmetic
EVIDENCE: screenshot, time, console/network error if any
SUGGESTED CHANGE (optional):
```

## 9. Immediate next actions

1. **Get the Git synchronization report.** Confirm Platform, Research, and Bot have identical `main` commits across both GitHub accounts. If blocked for permissions, resolve with the account owners; do not force-push or recreate histories.
2. **Read the current owner guide** and compare it with this handoff. Treat the current merged code and verified screenshots as more authoritative than any old campaign promise.
3. **Do a hands-on session with the owner** using disposable data. Begin with Shariah, chart/nav, mobile Alerts, Journal, and Stress. Take notes on the first place each person becomes confused.
4. **Create a short acceptance note** with `ACCEPT`, `ACCEPT WITH KNOWN LIMITATIONS`, or `BLOCKED`, supported by actual reproduction. Escalate only real functional/security problems; defer preference-only design changes.
5. **Schedule separate explicit integration gates** for Google OAuth, real Bot-connected Shariah testnet enforcement, exchange testnet trading, two-Mac Compute Helper, and realistic nonzero-trade WF/Holdout if/when the required services/hardware are available.

---

**Handoff integrity note:** The V4 package and independent review were examined offline; the later polish completion figures and GitHub PR/CI status come from the owner's supplied Claude transcript. This handoff was prepared without direct access to the owner's or Mahamid's private GitHub accounts or live Mac and therefore **cannot certify final `main` parity, real deployments, or runtime behavior after synchronization**. The *Verification record* below supplies the Git and documentation checks that were run on the owner's Mac after the document was written.

## Verification record (2026-11-02, Claude Code, owner's Mac)

Every technical and Git-status claim above was checked against the local checkouts at the merged commits, the campaign evidence folders, and the GitHub API. Claims found correct and left verbatim: the admin-only pages (Journal, Trading, Optimizers, Research, Stress, Operations are wrapped in the administrator-only guard); the three Quick Backtester strategy families; the 200,000-source-bar ordinary-user history bound (`platform/backend/src/api/historyAdmission.ts`); the Stress integrity states *Complete / Impaired (exactly one bar missing) / Not comparable (two or more) / Not verified (legacy)* (`platform/backend/src/engine/stress.ts`, `platform/frontend/lib/stress.ts`); the loopback-only Research link copy; the Binance Spot USDT-quoted base-asset universe; bot-managed 30-second TP/SL polling with no exchange-native stop; the test totals 4,171 (V4) and 4,178 (polish); the corrected 10 fixed / 2 partial / 4 out-of-scope visual matrix (polish report item E1); the single native crash of the backend suite under concurrent load with a clean solo rerun; the four `/private/tmp` directories relocated to the SSD with symlinks; the 16-trade same-Mac helper parity; the Screener HTTP 451; and the zero-trade Walk-forward/Holdout smoke at the shipped `initialCapital: 1000` and `qty_cash: 1000`. Corrections made in this copy: the status boundary and Git state (PRs now merged; Research synced; Platform blocked on Mahamid's side; Bot unchanged); repository visibility as read from GitHub; the Journal wording; the location of the independent review documents; the deployment-integration check. One discrepancy was found and **not** changed: `bot/docs/BOT_COMPLETE_GUIDE.md` describes `MuhammadMuhamid/3commabotclone` as private while GitHub reports it public; correcting it would add a Bot commit that cannot be mirrored to a public remote under the owner's current rules, so it is listed as a pending owner decision. The living documentation on `main` (owner guide, UI/UX contract, accounts, operations, Stress, Shariah universe, platform and Research READMEs, Research controller guide) was reviewed against the same claims and needed no change. Nothing in this file was tested on Mahamid's device.
