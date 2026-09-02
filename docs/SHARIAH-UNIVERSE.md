# Trading Scene Shariah Universe

**Status:** SH-3. Screening registry + Binance Spot USDT universe sync (SH-1);
explicit review/publication, immutable published-decision history, and immutable
universe snapshots with a Research-facing read contract (SH-2); the manual
batch-research workflow and Shariah Mode exposure enforcement across Platform's
Spot BUY paths (SH-3). No Research integration, no automated evidence
collection, no AI classification, and **no model API, paid search API or web
crawler of any kind**.

## Purpose and fixed premises

This is a screening methodology, not a fatwa generator. It answers exactly
one question per asset:

> Is the underlying asset/project that we are buying itself materially
> connected to a prohibited activity under `TS_SHARIAH_V1`?

Fixed, not re-litigated: spot cryptocurrency trading is permissible, USDT is
permissible, and Binance Spot is the trading venue/universe. The unique
underlying **base asset** is screened once — not every `XYZUSDT` pair
separately. USDT itself is accepted as quote and is never screened; if
another asset appears as the base of a qualifying `XYZUSDT` symbol (e.g. a
different stablecoin), it is screened normally like any other base asset.

## `TS_SHARIAH_V1`

Defined in `platform/backend/src/shariah/policy.ts`, the single source of
truth for the version string, prohibited-category vocabulary, and
interpretation rules. A future methodology change is a new explicit version
(`TS_SHARIAH_V2`, ...); `TS_SHARIAH_V1`'s meaning never silently changes.

Substantive questions asked of every base asset:

1. What is the actual project/asset?
2. What does the token/coin represent or do?
3. Does the project's own core/material activity, or the asset itself,
   directly represent, finance, provide, or materially depend upon an
   excluded activity?
4. Is there enough reliable evidence to classify it?

### Prohibited categories

Fixed list, not dynamically extended:

- Riba / interest-based finance
- Gambling / betting / casino
- Pornography / adult sexual business
- Alcohol
- Pork / clearly prohibited food business
- Tobacco
- Conventional insurance
- Direct ownership, financing, or economic representation of a clearly
  prohibited business

### Interpretation rules

- Third-party use of neutral infrastructure for prohibited purposes does not
  itself exclude the asset.
- Meme status has no Shariah classification effect.
- Category labels (DeFi, DEX, staking, GameFi, AI, L1, L2, utility, and
  similar) do not independently determine classification.
- A token issued by a company is not automatically equivalent to owning
  equity in that company.
- Parent-company activity matters only when the token/project economically
  represents, finances, materially depends upon, or grants rights tied to
  that activity.
- No percentage prohibited-revenue thresholds are invented.
- Mixed, significant, or unclear materiality resolves to `REVIEW`.
- Absence of evidence is not proof of eligibility.
- AI statements are not evidence.

## Status and lifecycle model

Public classification: `ELIGIBLE`, `EXCLUDED`, `REVIEW`.
Internal lifecycle: `SCREENED`, `UNSCREENED`, `STALE`.

Effective status (`effectiveShariahStatus` in `policy.ts`), the only function
downstream consumers should use:

| Lifecycle              | Effective status                        |
|-------------------------|------------------------------------------|
| `UNSCREENED`            | `REVIEW`                                 |
| `STALE`                 | `REVIEW`                                 |
| `SCREENED`              | its published classification             |
| *(no record / unknown)* | `REVIEW`                                 |

Missing or unknown state never defaults to `ELIGIBLE`.

## Stable asset identity

`shariah_assets.asset_id` is the permanent identity; ticker text is never
used as one. `shariah_asset_binance_mappings` holds the current Binance base
symbol for that asset (`base_asset` is its primary key, so at most one live
asset per symbol at a time). Keeping the mapping in its own table means a
future ticker rename, project rebrand, token migration, or ticker reuse only
ever touches the mapping — the `asset_id` and its Shariah history are
untouched. This is scoped to Trading Scene's Binance Spot USDT universe, not
a general-purpose crypto identity resolver.

## Binance Spot USDT universe sync

`platform/backend/src/shariah/sync.ts` derives the qualifying base-asset set
from two inputs, both already-authoritative and already in place — nothing
new was built to represent them:

- **Current Binance Spot exchange metadata** — `status`, `baseAsset`,
  `quoteAsset` per symbol, the same shape `data/binanceRest.ts`'s
  `listExchangeSymbols()` (SPOT-permission-scoped) already returns. Sync
  takes this as an argument; it makes no network calls itself.
- **Symbols Trading Scene supports** — the existing `symbols` table
  (`001_init.sql`), Trading Scene's own tracked-pair authority since day one.

A base asset qualifies when its `XYZUSDT` symbol is Binance status `TRADING`,
quoted in `USDT`, and present in `symbols`. `syncShariahUniverse` then:

- creates a new `shariah_assets` + mapping row, and an `UNSCREENED` /
  `REVIEW` `shariah_records` row, for a base asset never seen before;
- marks an existing mapping's `binance_available = true` and bumps
  `last_seen_at` otherwise;
- flips `binance_available = false` for any previously-qualifying base asset
  no longer in the qualifying set (a delisting), without deleting the asset,
  mapping, or Shariah record.

Sync is idempotent: repeated identical input creates no duplicate rows, and
one base asset always resolves to the same `asset_id` even across repeated
qualifying-symbol processing (`base_asset` is the mappings table's primary
key). See `tests/shariahUniverse.test.ts`.

**New listing:** discovered → `UNSCREENED` → effective `REVIEW`. Sync never
writes `ELIGIBLE` or `EXCLUDED` — there is no code path in `sync.ts` that
produces either. A real asset is never auto-classified.

**No automatic AI classification** anywhere in this boundary. Evidence
(`shariah_evidence`: URL, title, publisher, `retrieved_at`, excerpt) is a
plain persistence boundary for facts a human or a later process supplies —
nothing here collects, scores, or reviews it automatically, and no numeric
halal/confidence score is stored.

## Review and publication (SH-2)

A classification is never a side effect. `platform/backend/src/shariah/publication.ts`
is the single authority that can move an asset to `SCREENED` and give it a
public classification, and `POST /api/shariah/assets/:assetId/publications` is
its only HTTP entry point. Universe sync still writes nothing but
`UNSCREENED`/`REVIEW`, and there is no generic "set classification" repository
call anywhere.

A publication carries, and permanently records:

- `asset_id` (stable identity) and the Binance base symbol *at publication time*;
- `policy_version` = `TS_SHARIAH_V1`;
- `classification` — `ELIGIBLE` / `EXCLUDED` / `REVIEW`;
- `lifecycle` = `SCREENED` (constrained to that literal — publishing is the
  only way in, and the only thing a publication row can say);
- `reason` — required for **every** classification, `REVIEW` included;
- `prohibited_categories` — required (≥ 1) for `EXCLUDED`, forbidden for
  `ELIGIBLE`, optional for `REVIEW`;
- `reviewed_at` — when the review was actually completed, supplied explicitly
  and never defaulted to "now";
- `published_at`, `published_by` — the operator identity from the signed
  session cookie, never from the request body;
- the `shariah_evidence` rows that supported it.

### Publication rules

| Classification | Requires |
|---|---|
| `ELIGIBLE` | reason + `reviewed_at` + **at least one cited evidence row**. Absence of evidence is not proof of eligibility. May not carry prohibited categories. |
| `EXCLUDED` | reason + `reviewed_at` + **at least one prohibited category** + **at least one cited evidence row**. |
| `REVIEW` | reason + `reviewed_at`. Evidence is optional *because insufficiency is the finding* — a deliberately published `REVIEW` is the statement that the evidence is insufficient, conflicting, materially ambiguous, or mixed, and the reason must say which. |

Cited evidence must already belong to the asset being published. No numeric
halal/confidence score exists anywhere, and no percentage threshold is invented.

### `STALE` means a full re-screen

`STALE` is not a status to be reconfirmed. There is no
`reconfirm(assetId)`, no "restore previous classification", and no shortcut of
any kind — and there cannot accidentally become one, because the publication
authority **never reads the asset's existing classification or lifecycle**. It
has nothing to copy forward.

A `STALE` asset therefore reaches `SCREENED` only by submitting exactly the
same complete package a never-reviewed asset submits. Its prior publications
remain visible as history; that history is *evidence of what was said*, never
current proof. This preserves SH-1's fail-closed answer to ticker reuse: a base
symbol reappearing after a delisting demotes a `SCREENED` record to `STALE`, so
it resolves to `REVIEW` until it is genuinely re-screened.

### Publication history

Each successful publication appends one row to `shariah_publications` plus its
`shariah_publication_evidence` links, and only then updates the mutable current
`shariah_records` row (which carries `current_publication_id` pointing back at
the decision that produced it).

Both history tables reject `UPDATE` and `DELETE` **at the database level** —
`023_shariah_publication_and_snapshots.sql` installs an append-only trigger, so
no application bug, repository helper, or `psql` session can silently rewrite a
published decision. A later decision adds a row; it never edits one. Cited
evidence cannot be deleted out from under the decision that relied on it.

`shariah_evidence` is unchanged and remains factual source material — URL,
title, publisher, `retrieved_at`, excerpt. SH-2 adds only the relational
boundary that says *which decision relied on which fact*.

## Immutable universe snapshots (SH-2)

A snapshot (`platform/backend/src/shariah/snapshot.ts`) freezes the
authoritative Shariah state of the Binance Spot USDT base-asset registry at one
instant, so a future Research or Backtester run can cite exactly which universe
it used and prove it has not moved since.

`shariah_universe_snapshots` holds `snapshot_id`, `created_at`,
`policy_version`, `entry_count` and `content_hash`.
`shariah_universe_snapshot_entries` holds the frozen membership: `asset_id`,
the Binance `base_asset` **at snapshot time**, `effective_status`, the
underlying `classification` and `lifecycle`, `binance_available`, the
`policy_version`, and the `publication_id` the state came from.

Three properties, all structural rather than conventional:

- **No mutable joins.** Every field needed to interpret an entry is copied in.
  Reading an old snapshot never consults today's registry, so a later ticker
  rename, delisting, or re-screening cannot change what it says.
- **Immutability.** Both snapshot tables reject `UPDATE` and `DELETE` at the
  database level. A snapshot is never rewritten and never partially refreshed.
- **Determinism.** Membership is canonically ordered (by base symbol, then
  numeric `asset_id`) and canonically shaped in application code *before*
  hashing, so `content_hash` (sha256) is a function of the authoritative state
  alone and never of database row order.

### Snapshot universe semantics

A snapshot describes the **complete** authoritative state, not a pre-filtered
trading list:

- `ELIGIBLE`, `REVIEW` and `EXCLUDED` are all present and distinguishable.
- `UNSCREENED` and `STALE` members appear with `effective_status = REVIEW` — a
  database `CHECK` enforces that a non-`SCREENED` entry can only ever read
  `REVIEW`. Their stored `classification`/`lifecycle` are kept beside it, so
  "reviewed and found ambiguous" stays distinguishable from "never screened".
- `REVIEW` assets are never omitted just because a consumer may later want an
  eligible-only universe.
- Delisted assets are included, carrying `binance_available = false`, so a
  consumer can reconstruct either the tradable universe or the full audit view.

Future Research derives eligible-only, all, or custom universes from that
immutable evidence.

### Repeat creation

Taking a second snapshot of unchanged state **appends a new snapshot row
carrying the same `content_hash`**. Nothing is reused and nothing is mutated;
equality of universe content is expressed by the hash, not by the snapshot id.
`(policy_version, content_hash)` is deliberately not unique.

### What a snapshot does *not* mean

A snapshot represents the policy and universe **at the moment it was created**.
It is not a reconstruction of historical Shariah eligibility for earlier market
years: a snapshot taken today says what `TS_SHARIAH_V1` and the current review
state say today, and citing it in a backtest over 2021 data means "screened
under today's published state", not "this is what was eligible in 2021".

## Research-facing read contract (SH-2)

Research is **not** modified in SH-2. Platform simply exposes the smallest
stable contract a future integration can consume, under the existing
authenticated Platform API conventions — every path below sits behind the
server's global session gate (`api/server.ts`), including the read routes:

| Route | Purpose |
|---|---|
| `GET /api/shariah/universe` | Current registry + effective statuses + counts (operator view). |
| `GET /api/shariah/assets/:assetId` | One asset with its evidence and full immutable decision history. |
| `POST /api/shariah/assets/:assetId/evidence` | Record a factual evidence note. |
| `POST /api/shariah/assets/:assetId/publications` | **Publish** a decision. |
| `POST /api/shariah/snapshots` | Create an immutable snapshot. |
| `GET /api/shariah/snapshots` | Snapshot metadata list (id, policy version, content hash, entry count, created_at). |
| `GET /api/shariah/snapshots/latest` | Newest snapshot, with membership. |
| `GET /api/shariah/snapshots/:snapshotId` | One snapshot: metadata + frozen membership. |

The intended architecture is:

> Platform authoritative Shariah snapshot → this stable read contract →
> Research stores the snapshot id + `content_hash` in its run provenance.

Research must **not** open a second database connection to Platform's
PostgreSQL. A consumer can re-hash the membership it was handed and check it
against the returned `content_hash`, so the citation is verifiable rather than
merely recorded.

## Operator review surface (SH-2)

`platform/frontend/app/shariah/page.tsx` is the private review console reached
from the "Shariah" nav entry: list assets needing attention, inspect one asset's
current state and evidence, record a factual evidence note, select the evidence
that supports the decision, and publish a classification with a reason (and
prohibited categories where applicable). It also creates snapshots and lists
their content hashes.

It is deliberately small: no classification logic runs in the browser, nothing
is preselected, and the backend's refusal of an incomplete review is shown
verbatim so the rule has exactly one home. It is not a compliance dashboard.

## Batch review with ChatGPT (SH-3)

The research step deliberately runs **outside** Trading Scene, in a ChatGPT
subscription the operator already pays for. Trading Scene calls no model API, no
paid search API and no crawler, and adds no recurring cost. It exports a bounded
JSON pack, and imports a strict JSON result:

```
Trading Scene  --  TS_SHARIAH_REVIEW_PACK_V1 (20 assets)  -->  operator
operator       --  uploads the pack                       -->  ChatGPT
ChatGPT        --  researches the web, answers            -->  operator
operator       --  TS_SHARIAH_REVIEW_RESULTS_V1           -->  Trading Scene
Trading Scene  --  validate, record evidence, publish     -->  registry
```

### `TS_SHARIAH_REVIEW_PACK_V1` (export)

`platform/backend/src/shariah/reviewPack.ts`, served by
`GET /api/shariah/review-pack` and downloaded from the `/shariah` console.

**Default batch size is 20 assets** (`?size=` overrides, capped at 100).
The default batch is the work that is actually outstanding — assets that are
`STALE`, `UNSCREENED`, or a published `REVIEW` — and excludes settled
`ELIGIBLE`/`EXCLUDED` assets and assets Binance no longer lists
(`?includeSettled=true` / `?includeUnavailable=true` override).

Ordering is deterministic: **`STALE` → `UNSCREENED` → `REVIEW`**, then by base
symbol, then by numeric asset id. `STALE` comes first because it is the only
bucket where a real published answer was withdrawn. Downloading twice against
unchanged state yields the same batch.

Each asset carries `assetId`, `baseAsset`, `projectName`, `binanceAvailable`,
`lifecycle`, `classification`, `effectiveStatus`, `policyVersion`, a plain-language
`reviewReason`, `requiresFullFreshScreening`, `staleSince`, the prior publication
summary, and a reference list of prior evidence. The pack also embeds the fixed
`TS_SHARIAH_V1` premises, the six research questions, the eight prohibited
categories, the interpretation rules, and the exact result contract.

The pack contains **no** secret, credential, session, cookie, user identity,
balance, position, order, trading history or unrelated database state. It is
written to be handed to a third party, and a test asserts the closed field set.

### `TS_SHARIAH_REVIEW_RESULTS_V1` (import)

`platform/backend/src/shariah/reviewImport.ts`, served by
`POST /api/shariah/review-results/preview` (dry run, writes nothing) and
`POST /api/shariah/review-results/import`.

Per result: `assetId`, `baseAsset`, `policyVersion`, `classification`, the six
`answers`, `reason`, `prohibitedCategories`, `evidence[]` (`url`, `title`,
`publisher`, `retrievedAt`, `note`) and `unresolvedUncertainties[]`. The document
carries `format`, `policyVersion` and `researchCompletedAt`.

The schema is **closed**: any unrecognised key is an error. That is what
enforces "imported content is data, not instructions" — there is deliberately no
`evidenceIds`, `publicationId`, `lifecycle` or `reconfirm` field, so the file has
no vocabulary for naming a database row to mutate or for restating a prior
decision. Rejected: unknown asset ids, asset/base mismatch, the wrong policy
version, duplicate entries, unsupported classifications, non-http(s) or malformed
evidence URLs, future retrieval times, invented prohibited categories, `EXCLUDED`
without a category and evidence, and `ELIGIBLE` without evidence. Every problem
in a file is reported at once; nothing is executed, fetched or rendered as markup.

### One import, one approval

The import request **is** the human publication approval for the whole batch —
the operator approves 20 researched assets once, not one at a time. It is
all-or-nothing: validation completes first, so a file with one bad entry
publishes nothing, and the whole batch then commits in a single transaction.

Every decision goes through `src/shariah/publication.ts`, the same and only
publication authority a hand-entered decision uses (the import calls
`publishShariahDecisionWithin`, which is that function's body inside the
caller's transaction). So a batch import produces exactly the normal footprint:
evidence rows, an immutable `shariah_publications` row, publication-evidence
links, and the updated current pointer. History remains append-only.

Snapshots are **not** taken per imported asset. The operator creates one
snapshot when they have finished importing, using the existing capability.

### `STALE` is still a full re-screen

A `STALE` result must cite at least one evidence entry retrieved **at or after**
`staleSince`, for every classification including `REVIEW`. Pasting back
pre-staleness research to restore the old classification is refused. Combined
with the closed schema, there is no reconfirm path at all — only a fresh review.

## Shariah Mode (SH-3)

Persistent server-side setting in `app_settings` under `shariah.mode`
(`src/shariah/mode.ts`), read and written through `GET`/`PUT
/api/shariah/mode` and toggled on the `/shariah` console. **Default `off`.** It
lives on the server because the gate that enforces it lives on the server; the
browser toggle renders what the server reports and never holds the authoritative
value. Mode and classification are read fresh per intent — there is no cache, so
a re-screening or a mode change is in force immediately.

- **`off`** — behaviour is exactly as before. Nothing is blocked.
- **`enforce`** — **new exposure** requires `ELIGIBLE`.

### What "new exposure" means

Spot only. There are no futures, margin or short semantics.

| Side | Effect | Gate |
| --- | --- | --- |
| `BUY` | creates or increases exposure | applies |
| `SELL` | reduces or exits exposure | **never applies** |

`REVIEW`, `EXCLUDED`, `UNSCREENED`, `STALE` and an unresolvable registry
identity all block a BUY when enforcing. `UNSCREENED`/`STALE` have already
collapsed to `REVIEW` in `policy.ts`; a symbol with no registry identity (a
non-USDT quote, an unknown base asset) fails closed to `REVIEW` rather than
being treated as unclassified-therefore-fine.

**SELL, reduce and exit are always allowed**, in every status and every mode,
including for an asset whose identity cannot be resolved. An asset re-screened
`EXCLUDED` must remain exitable.

**A status change never liquidates anything.** The gate returns allow/deny for
an intent the caller already had; it constructs no order, closes no position and
cannot reach an execution path. Turning Shariah Mode on blocks the next entry —
it does not sell what you hold.

### One gate, every path

`src/shariah/gate.ts` is the single backend authority
(`assertShariahExposureAllowed` / `evaluateShariahGate`), called from every
Platform path that can create Spot exposure:

- **manual chart trading** — `POST /api/manual-trading/orders`, gated before the
  Bot is contacted. A blocked BUY is a `403` with an operator-readable reason,
  not a generic failure. Any client-supplied `shariah` key is discarded.
- **automated live, Paper, and `off` delivery** — `LiveRunner.fireAlert()`, at
  the same chokepoint as the risk gate and above the branch that separates the
  delivery modes. **Paper and live therefore agree by construction**: there is
  one gate call, not two implementations to keep in step. A blocked signal is
  recorded as a `blocked` alert and never advances runtime state.
- **live test-signal** — `POST /api/deployments/:id/test-signal`, which places a
  real order through the same dispatcher.

Order cancellation and stop-loss/take-profit protection edits are not gated:
neither can create exposure, and an `EXCLUDED` position must stay exitable.

Frontend disabling is UX. The backend gate is the enforcement.

### Screener, chart and manual trading

`GET /api/shariah/status?symbol=` returns the **gate's own decision** for a
hypothetical BUY (`buyAllowed`, `buyBlockedReason`, `sellAllowed: true`) rather
than raw registry fields. Every surface renders that one answer, so no component
re-derives the rule or can disagree with enforcement:

- **Screener** — a `Shariah` column (`ELIGIBLE`/`REVIEW`/`EXCLUDED`/`UNKNOWN`)
  joined from the registry, plus a one-click "Shariah-eligible only" filter.
- **Chart / manual trading panel** — the current asset's status, and, when a BUY
  is blocked, the reason; the SELL side stays available.

## Platform → Bot signed Shariah context (SH-3)

Every manual Platform → Bot execution request can carry a `shariah` block with
exactly these keys:

```json
{ "shariah": {
    "mode": "off" | "enforce",
    "policyVersion": "TS_SHARIAH_V1" | null,
    "assetId": "123" | null,
    "baseAsset": "BTC" | null,
    "effectiveStatus": "ELIGIBLE" | "REVIEW" | "EXCLUDED",
    "publicationId": "456" | null } }
```

`policyVersion` is `TS_SHARIAH_V1` whenever `mode` is `enforce`.
`effectiveStatus` is always one of the three public answers — `UNSCREENED` and
`STALE` are resolved to `REVIEW` by Platform before sending. `publicationId` is
the current publication when one exists, and `null` only where the state
legitimately has none. `assetId` is the registry's own scalar identity,
unconverted. The block is computed by the backend gate; a client-supplied
`shariah` key is stripped and never forwarded.

The block travels **inside the request body**, which
`manualTrading/client.ts` canonicalises in full (recursively, keys sorted at
every level) into the HMAC. It is therefore signed evidence, not an unsigned
advisory field: adding, removing or editing any key in it invalidates
`x-manual-signature`.

**Paired-release flag.** Sending the block is gated by
`SHARIAH_BOT_CONTEXT_ENABLED` (default `false`) because the Bot's manual submit
schema is `.strict()` and would reject an unrecognised field, failing every
manual order. Ship the Bot side first, then enable it. **Enforcement does not
depend on this flag** — the gate runs Platform-side before the request is built
either way; the flag only controls whether the decision travels to the Bot.

The automated webhook dispatcher (`alerts/dispatcher.ts`) does **not** carry the
block: its payload is the vendored, fingerprinted `webhookContract.ts` shared
byte-for-byte with the Bot, and extending it is a paired contract change.
Enforcement on that path is unaffected — the gate refuses the signal before
`deliver()` is reached.

## Read boundary

`platform/backend/src/repositories/shariah.ts` is the one authoritative
place later Screener, Chart, Research, Paper, and live-trading/Bot
integrations should read Shariah state from: resolve by base symbol, list
the active universe (with effective status), filter by effective status,
list `UNSCREENED`/`STALE` maintenance candidates, evidence read/write,
publication history, and snapshot reads. SH-2's HTTP routes are thin wrappers
over it. There is still no generic "set classification" write path: sync only
produces `UNSCREENED`/`REVIEW` rows, and `src/shariah/publication.ts` is the
only thing that can publish one.

## Scope

**SH-1 delivered:** policy definition, stable asset identity, Shariah record
persistence, evidence-ready persistence, idempotent Binance Spot USDT sync,
the read boundary above, and the fail-closed ticker-reuse rule.

**SH-2 delivered:** the explicit review/publication authority and its rules,
append-only evidence-backed decision history, `STALE` = full re-screen,
immutable deterministic universe snapshots, the authenticated Research-facing
snapshot read contract, and the minimal private operator review surface.
Migration `023_shariah_publication_and_snapshots.sql` is additive; migration
022 and earlier are untouched apart from one new nullable column.

**SH-3 delivered:** the `TS_SHARIAH_REVIEW_PACK_V1` batch export (default 20,
deterministic order), the strict `TS_SHARIAH_REVIEW_RESULTS_V1` import routed
through the existing publication authority, Shariah Mode, the single backend
exposure gate across every Platform Spot BUY path (manual, automated live,
Paper, live test-signal), the Screener column and filter, the chart/manual-trade
status and blocked-BUY reason, and the signed Platform → Bot Shariah context.

**Still explicitly deferred:** the Bot-side handling of the signed `shariah`
block (a paired release; Bot is untouched here), the same block on the vendored
webhook contract, Backtester consumption, the actual Research integration
(Research is untouched), AI evidence research / web scraping / monitoring,
scholar engines, numeric halal/confidence scores, autonomous or automatic
classification of any kind, a general historical ticker/project identity
resolver, and Strategy Discovery.

## Known V1 identity limit

Asset identity is still resolved through the current Binance base symbol. A
genuinely different project that later reuses an old ticker can share the
historical `asset_id`. SH-1 fails closed on this by demoting a reactivated
`SCREENED` record to `STALE` (effective `REVIEW`), and SH-2 preserves that
property: such an asset requires a full fresh review before it can be
`ELIGIBLE` again. A sophisticated historical identity resolver remains out of
scope.
