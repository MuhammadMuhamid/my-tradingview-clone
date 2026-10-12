# Trading Scene — Shariah Screening: Final System Guide

Date: 2026-10-11 · Platform branch `finalization/mahamid-reconcile-premium-parity-20260918` ·
Bot branch `finalization/bot-halt-exits-20261011` @ `88a8bfe`
Authority: current source, tests and migrations. Where an older document (including
`docs/SHARIAH-UNIVERSE.md`) disagrees, the code wins.

---

## 1. What this is — and what it is not

Trading Scene's Shariah feature is a **controlled research and review workflow** with an
enforcement gate. Policy `TS_SHARIAH_V1` (`src/shariah/policy.ts`) is *"a screening methodology,
not a fatwa generator."*

- It is **not** an autonomous religious authority. It never decides anything by itself: *"every
  classification is published deliberately by you. Nothing here is decided automatically."*
- It does **not** ask an AI whether something is halal. Trading Scene calls **no model API, no
  paid search API and runs no crawler** (`src/shariah/reviewPack.ts`). Research happens outside
  the system, in a tool the operator chooses (the UI names ChatGPT with web research on the
  operator's own subscription). It comes back as **data** that is validated, read and published by
  a human. The interpretation rules state explicitly: *"AI statements are not evidence."*
- Fixed premises, not re-litigated: spot crypto trading is permissible, USDT is permissible,
  Binance Spot is the venue. The **base asset** is screened once, not each USDT pair.

## 2. Workflow

```
SELECT ASSETS → EXPORT PACK → EXTERNAL RESEARCH → IMPORT (Check results) → VALIDATE
   → REVIEW (read each decision) → PUBLISH (Import & publish / single publish) → MONITOR
```

Screen: `/shariah` (`frontend/app/shariah/page.tsx`), two tabs.

- **Status:** Platform mode (OFF/ON), Bot floor, *Universe at a glance* (Active / Eligible /
  Review / Excluded / Due for re-review), re-review policy (180 / 365 / 730 days / never).
- **Screening & publication:** *Batch review with ChatGPT* (steps 1–3), universe list with
  selection, per-asset review panel (evidence, publish decision, published history), snapshots,
  *Sync universe*, *Create universe snapshot*, *Turn on* (mode).

## 3. The universe and asset identity

`src/shariah/sync.ts` maps current Binance Spot exchange metadata and Trading Scene's supported
symbols onto the registry: `shariah_assets` (one row per **base asset**, scalar `assetId`) and
`shariah_asset_binance_mappings` (base symbol ↔ asset, availability). Sync is idempotent and
**never classifies**: a newly seen base asset is created `UNSCREENED`. If a base symbol reappears
after a delisting, its record is forced **`STALE`**, because a reused ticker may belong to a
different project. Sync commits the mapping update and the STALE mark **atomically** (`2439d43`,
`shariahSyncAtomicity.test.ts`).

## 4. Status model

Two dimensions (`policy.ts`):

| Lifecycle (internal) | Classification (published) | **Effective status** (what the gate reads) |
|---|---|---|
| `UNSCREENED` — never screened | — | **REVIEW** |
| `SCREENED` | `ELIGIBLE` | **ELIGIBLE** |
| `SCREENED` | `EXCLUDED` | **EXCLUDED** |
| `SCREENED` | `REVIEW` (evidence insufficient, conflicting or ambiguous) | **REVIEW** |
| `STALE` — ticker reused / must be re-screened | (old one kept as history) | **REVIEW** |

`effectiveShariahStatus` collapses UNSCREENED and STALE to REVIEW. **UNKNOWN ≠ APPROVED:** a
symbol with no resolvable registry identity (non-USDT quote, unknown base, asset not in the
registry) is also REVIEW, never "unclassified, therefore fine" (`gate.ts`, fail closed on
identity). Interpretation rules that block shortcut answers: meme status has no effect; category
labels (DeFi, L1, GameFi…) do not decide; third-party use of neutral infrastructure does not
exclude; no invented revenue-percentage thresholds; *mixed, significant or unclear materiality
resolves to REVIEW; absence of evidence is not proof of eligibility.*

Prohibited categories (fixed): `RIBA_INTEREST_BASED_FINANCE, GAMBLING_BETTING_CASINO,
PORNOGRAPHY_ADULT_SEXUAL_BUSINESS, ALCOHOL, PORK_PROHIBITED_FOOD, TOBACCO,
CONVENTIONAL_INSURANCE, PROHIBITED_BUSINESS_OWNERSHIP_OR_FINANCING`.

## 5. Export pack (`TS_SHARIAH_REVIEW_PACK_V1`)

*Download next 20 for ChatGPT* (queue order: STALE, UNSCREENED, published REVIEW, then advisory-due settled decisions) or *Download pack for selected*
(`GET /api/shariah/review-pack`, `src/shariah/reviewPack.ts`). The pack is self-contained JSON
containing the policy questions, interpretation rules, prohibited categories, the
`TS_SHARIAH_REVIEW_RESULTS_V1` template to return, and per asset: `assetId`, base symbol, Binance
mapping, lifecycle, prior publication (context only) and cited evidence. Two load-bearing
properties:

1. **No private state.** No session, credential, user identity, balance, position, order or
   unrelated database data. It is written to leave the machine.
2. **A STALE entry asks for a full fresh screening, never a reconfirmation**
   (`requiresFullFreshScreening`, `staleSince`). The import side enforces it.

## 6. External research

The operator uploads the pack to their research tool, which researches each project and fills the
results template: `classification`, `reason`, `prohibitedCategories`, `evidence[]` (URL, title,
publisher, `retrievedAt`, factual note) and `unresolvedUncertainties[]`. This step is outside
Trading Scene by design.

## 7. Import and validation (`TS_SHARIAH_REVIEW_RESULTS_V1`)

Paste the JSON (or choose the file) → **Check results** (`POST /api/shariah/review-results/preview`)
→ read each decision → **Review publication summary** → **Import & publish** (`POST /api/shariah/review-results/import`). *"This one
action is your approval for the whole batch."* `src/shariah/reviewImport.ts` refuses the **whole
batch** on any problem, with one line per problem. Live example from this session: an incomplete
document returned *"Nothing was published. Fix the file and check again."* plus
`policyVersion must be TS_SHARIAH_V1`, `researchCompletedAt must be an ISO-8601 timestamp`,
`unrecognised field "asset"`, `assetId must be the numeric id copied from the review pack`, etc.

Rules enforced:
- exact format and policy version; numeric `assetId` and `baseAsset` must match the registry;
- `ELIGIBLE` and `EXCLUDED` require cited evidence; `EXCLUDED` requires at least one prohibited
  category; every classification (REVIEW included) requires a reason;
- **STALE assets:** evidence must have been retrieved *after* the asset went stale, so the old
  decision cannot be pasted back;
- results listing `unresolvedUncertainties` publish only if the operator acknowledges that asset
  by id (`assertUncertaintiesAcknowledged`);
- the approving operator identity is recorded; `source: "review_import"` marks the provenance.

## 8. SHARIAH-IMPORT-RACE (concurrency protection, `2439d43`)

**Risk:** the import's cheap pre-validation passes, then a concurrent universe sync reactivates a
reused ticker (marking it STALE) *before* publication. The import would then publish a decision
that copies an old verdict onto what may be a different project.

**Correction:** the import opens one transaction, locks the affected
`shariah_asset_binance_mappings` rows `FOR UPDATE` in stable `asset_id` order (so concurrent batch
imports cannot deadlock in file order), **re-reads the registry under the lock and re-validates**,
then publishes every entry and commits once. Sync updates each mapping before marking STALE, so it
cannot withdraw a decision between the check and the publication. Any failure rolls back and
publishes nothing. Proven against real PostgreSQL concurrency in the nonvisual closure
(`shariahUniverseDb.test.ts`, `shariahReviewBatch.test.ts`).

## 9. Single-asset review and publication

Selecting an asset opens its panel: lifecycle and effective status, **Evidence** (record URL /
title / publisher / retrieved-at / factual note: *"a fact you recorded, not a verdict"*), and
**Publish a decision** (classification chosen with *nothing preselected*, reason, prohibited
categories, review-completed-at) → *Publish under TS_SHARIAH_V1*
(`POST /api/shariah/assets/:assetId/evidence`, `…/publications`).

`src/shariah/publication.ts` is the **only** authority that can publish. It has no
`reconfirm()`, no `setClassification()`, and never reads the prior classification, so old status
cannot be copied forward. Each publication appends an immutable `shariah_publications` row (the
database rejects UPDATE/DELETE) with its evidence links, then updates the mutable current
`shariah_records` row. *"Published decisions are append-only."*

## 10. Provenance, snapshots and versioning

- Policy versions are explicit (`TS_SHARIAH_V1`); a future methodology is `V2`, never a silent
  change in meaning.
- **Universe snapshots** (`POST /api/shariah/snapshots`, `src/shariah/snapshot.ts`) freeze the
  registry so a Research/Backtester run can cite exactly which universe it used. Entries copy all
  interpretive fields (no mutable joins), the tables reject UPDATE/DELETE, and a canonical
  `content_hash` makes equal content provable. A repeat snapshot of unchanged state appends a new
  row with the same hash.
- Mode changes are recorded in `shariah_mode_changes` (`GET /api/shariah/mode/history`).

## 11. Freshness and re-review (STALE vs "due")

- **STALE** is event-driven (ticker reuse) and changes effective status to REVIEW, which blocks BUY
  under enforcement.
- **Age** is advisory (`src/shariah/freshness.ts`): after the configured period (default choices
  180/365/730 days or never; `shariah_review_policy`) a settled decision is counted *Due for
  re-review* and sorted to the front of the next pack. *"Advisory only — an aged decision still
  stands and is still enforced."* Nothing demotes an aged decision automatically, because bulk
  silent withdrawal would stop trading at a moment the operator did not choose. Age is measured from
  `reviewedAt` (when the research was done), not publish time, so a backlog cannot launder its
  staleness.

## 12. Enforcement: BUY/open vs SELL/close

Shariah **Mode** (`src/shariah/mode.ts`) is stored server-side (`app_settings`), default **OFF**.
OFF means trading behaviour is unchanged and no Bot floor is claimed.

With Mode **ON (`enforce`)**, `src/shariah/gate.ts` is the single Platform authority, called by
every new-exposure path (manual order route, Spot execution route, `LiveRunner`'s emission
chokepoint, live test signal):

| Intent | Mode OFF | Mode ON |
|---|---|---|
| **BUY** (open / increase) | allowed | allowed **only** if effective status is `ELIGIBLE`; REVIEW, EXCLUDED, UNSCREENED, STALE and unknown are refused (`403`, an operator-readable reason ending *"Selling or reducing an existing position is still allowed."*) |
| **SELL** (signal exit, TP, SL, partial close, manual close, reduce) | allowed | **always allowed — never gated** |

Nothing in the gate liquidates. A status change never generates an order. The only effect of an
asset going EXCLUDED is that the next BUY is refused. Non-Spot scopes under enforcement are
refused for BUY (the policy only covers Binance Spot crypto), and SELL is still never gated.

**Platform → Bot boundary.** Every execution request carries a signed `shariah` block (`mode`,
`policyVersion`, `assetId`, `baseAsset`, `effectiveStatus`, `publicationId`) inside the
HMAC-covered body. The Bot (`bot/backend/src/services/shariah.ts`) is *"the last gate before
Binance"*. It holds **no registry and does no screening**. It verifies the decision's signature,
freshness and symbol binding, admits a BUY only if it says ELIGIBLE (a module-private clearance
token is required to reach `marketBuyQuote`), and admits any SELL unconditionally (it only records
what the SELL asserted). **Bot floor:** turning Mode ON first arms the Bot over the HMAC control
channel and persists locally only if that succeeded. Turning OFF persists first, then disarms. The
stricter state always wins (`src/shariah/botEnforcement.ts`). This closes direct-webhook BUYs the
Platform never sees.

## 13. Halt, reduce-only, cancel, stop-loss, operator close

- **Operator halt** (risk controls, Platform and Bot alike): stops the *automation* in both
  directions, but **never an operator's own exit** (Bot D-9 fix `caa025e`; `evaluateBotHalt`). A
  manual BUY reserved just before a halt is rejected at reconcile rather than submitted after it
  (`88a8bfe`).
- **TP/SL monitor SELLs**, partial closes and reduce-only closes are exits, so they are never
  Shariah-gated. A malformed Shariah block on an exit is recorded as absent and never blocks the
  close (Bot `9286434`).
- Cancelling an open order creates no exposure and is not Shariah-gated.

## 14. SHARIAH-EXIT-OUTAGE (`2439d43`)

**Risk:** the screening store (mode read or registry lookup) is unavailable at the moment an
operator or the automation needs to exit. If the gate's failure propagated, the SELL would fail.
The operator would be trapped in a position exactly when the system is degraded.

**Correction:** in `manualTrading.ts`, `spotExecution.ts` and `LiveRunner`, the gate call is
wrapped. On a read failure **BUY fails closed** (the error propagates, nothing is sent). **SELL
proceeds** without a Shariah block: no approval is invented, the warning
*"exit proceeds without unavailable Shariah provenance"* is logged, and the Bot independently
treats a Spot SELL as an exit without reading a block. Healthy exits keep their provenance. Pinned
for both failure points (`readMode`, `lookupBaseAsset`) × both sides × manual, spot and
automation paths in `shariahExitAvailability.test.ts`.

**Why exits stay possible while new exposure is blocked:** the purpose of screening is to avoid
*acquiring* prohibited exposure. Refusing to *leave* a position never serves that purpose and can
cause real harm. So every layer — Platform gate, outage handling, halt, Bot — treats SELL as
always available.

## 15. Monitoring

Status tab counters (Active / Eligible / Review / Excluded / Due), Bot floor state, mode history,
per-asset published history, snapshots, and the *Needs review* count on the batch panel
(`GET /api/shariah/status`, `/universe`, `/assets/:assetId`, `/mode`, `/mode/history`,
`/review-policy`, `/snapshots`, `/snapshots/latest`, `/snapshots/:id`).

## 16. Failure modes

| Failure | Behaviour |
|---|---|
| Malformed / incomplete results file | whole batch refused, nothing published, per-line reasons |
| Concurrent sync during import | lock + revalidate; stale-ified asset refused; all-or-nothing |
| Screening store down | BUY fails closed; SELL proceeds without provenance |
| Bot unreachable when turning Mode ON | Mode stays OFF (honest), operator told |
| Unknown symbol / non-USDT quote | REVIEW → BUY refused under enforcement |
| Reused ticker | STALE → REVIEW; full fresh screening required |
| Aged decision | surfaced as due; still enforced; never auto-demoted |

## 17. API, database and migrations

Routes (`src/api/routes/shariah.ts`): `GET /api/shariah/status | universe | assets/:assetId |
mode | mode/history | review-policy | review-pack | snapshots | snapshots/latest |
snapshots/:snapshotId`; `PUT /api/shariah/mode | review-policy`; `POST /api/shariah/universe/sync
| assets/:assetId/evidence | assets/:assetId/publications | review-results/preview |
review-results/import | snapshots`.

Tables: `shariah_assets`, `shariah_asset_binance_mappings`, `shariah_records`,
`shariah_evidence`, `shariah_publications`, `shariah_publication_evidence`,
`shariah_universe_snapshots`, `shariah_universe_snapshot_entries`, `shariah_mode_changes`,
`shariah_review_policy`. Migrations **022** (universe), **023** (publication and snapshots,
immutability triggers), **043** (audit and freshness). Bot: Prisma migrations
`20260902120000_shariah_enforcement`, `20260903000000_shariah_authorization_nonce`.

## 18. Test coverage

Platform backend: `shariahGate`, `shariahExitAvailability`, `shariahPublication`,
`shariahReviewBatch`, `shariahRoutes`, `shariahScopeContract`, `shariahSyncAtomicity`,
`shariahUniverse`, `shariahUniverseDb` (real PostgreSQL), `shariahFreshness`,
`shariahBotEnforcement`. Frontend: `shariah.test.ts`, `shariahBotFloor.test.ts`; DOM
`shariahBatchReview.test.tsx`, `shariahUniverseSync.test.tsx`. Bot: `shariahEnforcement`,
`shariahControlPlane`, `shariahWireContract`, `tpslHalt`.

## 19. Limitations

- Coverage is Binance Spot USDT base assets only; other asset classes are refused for BUY under
  enforcement.
- Classification quality depends entirely on the operator's research and evidence. The system
  enforces completeness and provenance, not correctness of judgement.
- Freshness is advisory by design. Re-screening cadence is the operator's responsibility.
- The current dev install has 9 assets, all UNSCREENED (effective REVIEW), and Mode OFF.

## 20. Hypothetical walkthrough (illustrative)

1. **Select.** *Sync universe* creates `XYZ` as UNSCREENED (effective REVIEW). Tick XYZ →
   *Download pack for selected (1)*.
2. **Research.** The operator researches XYZ externally. The project is a general-purpose L2
   whose token pays network fees; there is no lending or gambling product of its own. The
   researcher cites the project's documentation and an independent explainer (URLs, publishers,
   `retrievedAt`), fills `classification: "ELIGIBLE"`, a reason, and no uncertainties.
3. **Import → Check results.** The validator confirms the format, policy, `assetId` / `baseAsset`
   match, evidence present → preview shows one ELIGIBLE decision.
4. **Publish.** *Import & publish*: one transaction locks XYZ's mapping, re-reads it (still
   UNSCREENED), appends an immutable publication with evidence links, updates the record →
   effective **ELIGIBLE**.
5. **Enforce.** Mode ON (Bot armed first). A BUY of `XYZUSDT` carries a signed block saying
   ELIGIBLE; the Bot admits it. A BUY of `ABCUSDT` (UNSCREENED) is refused with the reason.
6. **Change.** Months later XYZ launches a lending product. The operator re-screens, publishes
   `EXCLUDED` with category `RIBA_INTEREST_BASED_FINANCE`. Nothing is sold automatically; the next
   BUY is refused; the operator's SELL of the existing position is admitted.
7. **Ticker reuse.** XYZ delists and the symbol reappears for a different project → sync marks it
   STALE (effective REVIEW). The next pack demands a full fresh screening, and old evidence cannot
   be reused because its `retrievedAt` predates `staleSince`.
8. **Outage.** The database read fails during an exit → the SELL still goes (without
   provenance); a BUY at that moment fails closed.


## Post-release usability update — 2026-10-12

The landing view now explains the religious-authority boundary, each status,
Mode ON/OFF consequences, SELL availability and the absence of automatic
liquidation. **Review today** selects advisory reminders; unresolved work and
STALE/UNSCREENED counts are separate. Search finds ticker/project names. Selecting
due assets uses the existing bounded selected-pack contract. Downloading a pack
does not reserve or advance the queue.

Existing decisions show clickable HTTP(S) sources, publisher, retrieval time,
research age and exact publication citations. Research completion and publication
time remain distinct. A due ELIGIBLE decision remains ELIGIBLE; event-driven
STALE is effective REVIEW and blocks new BUY exposure when Mode is ON.

Checked batches now require a final summary showing counts, previous decisions,
citations and unresolved uncertainties. **Edit draft decision** lets the operator
explicitly correct classification, reason or categories before publication. The
original classification/reason is retained in the corrected reason. Any edit
invalidates the preview and acknowledgements; **Check results** reuses the strict
backend validator. Corrections do not silently change imported research or write
publications. Final **Import & publish** remains deliberate and all-or-nothing.

A blocked order offers an asset/symbol-specific `/shariah` link to review or view
the decision and evidence. This does not bypass the BUY gate; SELL/exits remain
available. Unknown identity cannot be made eligible merely by following a link.
