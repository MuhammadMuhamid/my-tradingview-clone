# Trading Scene Shariah Universe

**Status:** SH-2. Screening registry + Binance Spot USDT universe sync (SH-1),
plus explicit review/publication, immutable published-decision history, and
immutable universe snapshots with a Research-facing read contract (SH-2). No
trading/Bot/Paper enforcement, no Research integration, no automated evidence
collection, no AI classification.

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

**Still explicitly deferred:** trading/Bot/Paper/live/manual-trade enforcement,
Screener filtering, chart badges, Backtester consumption, the actual Research
integration (Research is untouched in SH-2), AI evidence research / web
scraping / monitoring, scholar engines, numeric halal/confidence scores,
autonomous or automatic classification of any kind, a general historical
ticker/project identity resolver, and Strategy Discovery.

## Known V1 identity limit

Asset identity is still resolved through the current Binance base symbol. A
genuinely different project that later reuses an old ticker can share the
historical `asset_id`. SH-1 fails closed on this by demoting a reactivated
`SCREENED` record to `STALE` (effective `REVIEW`), and SH-2 preserves that
property: such an asset requires a full fresh review before it can be
`ELIGIBLE` again. A sophisticated historical identity resolver remains out of
scope.
