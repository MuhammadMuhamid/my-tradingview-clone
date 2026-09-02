# Trading Scene Shariah Universe

**Status:** SH-1 foundation. Screening registry + Binance Spot USDT universe
sync only. No enforcement, no snapshots, no automated evidence collection.

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

## Read boundary

`platform/backend/src/repositories/shariah.ts` is the one authoritative
place later Screener, Chart, Research, Paper, and live-trading/Bot
integrations should read Shariah state from: resolve by base symbol, list
the active universe (with effective status), filter by effective status,
list `UNSCREENED`/`STALE` maintenance candidates, and evidence
read/write. There is no HTTP route yet — SH-1 has no consumer that needs
one, and adding one is a small follow-up against this same repository
module when a consumer arrives. There is no generic "set classification"
write path; the only writer in SH-1 is the sync boundary, which only ever
produces `UNSCREENED`/`REVIEW` rows.

## SH-1 scope

Delivered: policy definition, stable asset identity, Shariah record
persistence, evidence-ready persistence, idempotent Binance Spot USDT sync,
and the read boundary above.

Explicitly deferred to later phases: trading/Bot/Paper enforcement,
Research/Backtester integration, immutable Shariah run snapshots, AI
evidence research/web scraping/monitoring, scholar engines, numeric
halal/confidence scores, review/publication UI, and Strategy Discovery.
