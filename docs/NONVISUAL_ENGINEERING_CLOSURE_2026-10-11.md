# Nonvisual engineering closure — 2026-10-11

This is an append-only continuation of the accepted Claude/Opus campaign.
Engineering readiness is **pending** until fresh review and authoritative
validation below are complete. No main promotion or final release claim.

## Preflight

- Platform branch: `finalization/mahamid-reconcile-premium-parity-20260918`.
- Start HEAD and origin: `ef0738eb17d8b5b4e6a5188e5e9f5da8e332b18a`.
- Required branch/HEAD/origin/status/log commands run; fetch confirmed origin.
- Pre-existing tracked deletions: eight files under `graphify-out/`; preserved,
  excluded from this campaign's commits. Untracked `phase2/` preserved.
- Research accepted branch: `finalization/compute-helper-20261011`,
  `894e7335e29213f89c9d1ee025090a6a0499463a`, local equals fetched origin.
- Bot accepted branch: `finalization/bot-halt-exits-20261011`,
  `88a8bfe1125d40f2c955c67c3d098393265d7501`, local equals fetched origin.
- Both canonical checkouts initially lagged the accepted branches. Their old
  registered worktrees no longer existed; switched clean canonical checkouts
  to the accepted branches without deleting worktree records or rewriting history.
- Disk: 7.8 GiB initially, 8.0 GiB at targeted-validation checkpoint.
- Read the root campaign ledger and September handoff; their older open items
  were reconciled with later ledger entries, source, tests and Git history.
- Architecture retained: Platform decides, Bot executes, Research consumes.
- No subjective visual review, Fable launch, credentials changes or real orders.

## Proven findings and targeted corrections

| ID | Class | Evidence and correction |
|---|---|---|
| MONEY-FEE | ENGINEERING_P1 | 100 cash funded 100 notional plus an unfunded entry fee. `feeInclusiveAffordability` reserves fees at the equity-sizing boundary and refuses unaffordable fixed cash; the named correction changes engine identity and preserves older correction sets. |
| MONEY-FILL | ENGINEERING_P1 | Slippage could produce zero/negative exit prices and negative fees. Reject nonpositive/nonfinite fills before financial mutation, including canonical multiasset fills. |
| PINE-INPUT | ENGINEERING_P1 | Strategy Pine requests bypassed common money-setting validation. Reuse existing validators before data reads; Broker rejects invalid financial primitives. |
| STRESS-SETTINGS | ENGINEERING_P2 | Stress rejected valid fractional slippage copied from a run, while accepting impossible merged request/config strategy parameters. Preserve valid fractional ticks; validate merged parameters before discovery/queue. |
| STRESS-STORAGE | ENGINEERING_P2 | Both persisted slippage columns were integer, despite accepted fractional API settings. Migration `047_fractional_backtest_slippage.sql` widens them to numeric without changing existing values. PostgreSQL reproduced `22P02` for `1.5` before migration. |
| STRESS-ATOMIC | ENGINEERING_P1 | A visible empty coordinator settled DONE before children attached, and creation failures could orphan children. Coordinator, child runs and links now commit together; an empty historical coordinator is never evidence of completion. |
| ALERT-FAILCLOSED-EDIT | ENGINEERING_P1 | Editing a condition on corrupt authoritative gates silently reconstructed legacy/ungated state. Require explicit list replacement to repair; ordinary note/pause edits preserve refusal, and bulk edits validate before writing. |
| SHARIAH-EXIT-OUTAGE | ENGINEERING_P1 | A screening-store failure prevented manual SELL despite a healthy Bot. Preserve healthy provenance; omit unavailable provenance for exits, log the failure, keep BUY fail-closed. Test analogous callers while retaining automation halt semantics. |
| SHARIAH-IMPORT-RACE | ENGINEERING_P2 | Registry reactivation between import preflight and publication let old evidence overwrite STALE. Lock mappings and revalidate inside the existing batch transaction before writes; sync commits its mapping and STALE updates atomically with matching lock order. |
| HELPER-DELIVERY | ENGINEERING_P1 | Bounded retry exhaustion discarded completed work. Retain exact private transport archives and original owner metadata; preserve retry bounds and slot retirement. |
| HELPER-OWNER | ENGINEERING_P1 | Editing coordinator settings could send pending work to the replacement owner and preserve an old connected claim. Bind delivery to original coordinator; reset connection evidence on settings change. |
| HELPER-PRESENCE | ENGINEERING_P2 | Failed in-job heartbeats left connection status connected indefinitely. Apply the existing presence timeout during execution, without interrupting local scientific work. Retained-work notices survive later successful heartbeats. |

Research continuation: `finalization/nonvisual-compute-delivery-20261011`,
`33f5547541c0ce46bab47b67cab27178598748ca`, pushed and remote equality verified.
Follow-up truthful status checkpoint:
`43bc9faf5ecd922869865c33dc08cd945de54c6a`, pushed and remote equality verified.
Durable retained files require deliberate operator removal after no longer needed;
restart reports their count and never claims delivery or assigns an expired lease.

Red-first and focused evidence is recorded under
`/tmp/trading-nonvisual-20261011/`; final counts and review will be recorded here
so readiness never depends on transient scratch files.

Primary and specialist focused checks: Backtester/Stress/Pine 202/202;
Shariah/safety 159/159; alert edit/conditions 91/91 and neighboring alert/cache
103/103; frontend pure alert/data 64/64. Primary re-ran its mixed backend
focused set 86/86. Research helper 32/32 Python, staged helper 3/3 Python and
helper UI 16/16 Node. These are overlapping focused runs, not additive totals
and not the final authoritative suites.

## Evidence-based rejected / intentional findings

- Missing `environment` is a local provider-capability query, never a transmitted
  live default. Bot's stored account, mainnet feature flag and exact confirmation
  independently govern real execution. Preserve the accepted transport contract.
- X5 `positionEffect` is an accepted paper/practice-only, default-disabled
  limitation. Cross-repo OPEN/CLOSE extension is separate scope; changing the
  existing SELL exemption could recreate the netted-account exit trap.
- Bot manual BUY halt/reconciliation fixes and operator SELL exemptions are
  preserved at `88a8bfe`. Automation halt semantics remain deliberate.
- Shariah time-based freshness is advisory with due-state/review-queue surfacing;
  lifecycle STALE blocks exposure. Do not silently rewrite the accepted policy.
- `assertWindowUsage` is a tested specification, not a production guard;
  corrected documentation is already present. `evaluateClearance` remains the
  differential half of the enforced deployment `holdoutGate.mjs` contract.
- Gate list replacement, per-gate timeframe, cap ten, malformed evaluation
  refusal, unique-index contracts, dialog draft stability, and accepted candle
  caching/parallel pagination remain intact.
- Named pattern filters, in-app deployment holdout controls and broad strategy
  configuration tooling remain separate scope; no new architecture added.

## FABLE_OPUS_VISUAL_QUEUE

No new subjective visual review was performed. These are inherited deferred
items from the accepted ledger, requiring Fable/Opus adjudication, not assumed bugs:

| Surface | Reproduction | Estimate | Why queued / files / functional risk |
|---|---|---|---|
| Study price-scale pills | Show ATR and neighboring scale labels near the LWC packing midline; reproduce inherited B-13 overlap. | P2 | Visual overlap/library packing. `platform/frontend/components/CandleChart.tsx`; `platform/frontend/lib/axisTickClearance.ts`. May conceal a number; no new math defect established. |
| Pine settings Style/Visibility | Open Pine settings and inspect per-plot controls against accepted scope. | P2 / NEW_SCOPE | Deferred per-plot override storage capability, not an authorized redesign. `platform/frontend/components/tv/PineEditor.tsx`; settings integration in `CandleChart.tsx`. Could suggest unavailable customization; do not implement without Fable/owner scope adjudication. |
| Vertical crosshair time lock | Inspect the inherited deferred "Lock vertical cursor line by time" interaction. | P2 / NEW_SCOPE | Interaction acceptance belongs to Fable/Opus; `CandleChart.tsx`. No underlying replay/time-state defect established here. |
| Loading transients | Rapid symbol/timeframe switch with Pine studies: inspect inherited overlay-before-candles and loading-label placement notes. | P2/P3 | Visual timing/placement acceptance. `CandleChart.tsx`, `components/tv/IndicatorLegend.tsx`. Escalate only if Fable reproduces foreign/stale data, rather than transient presentation. |

## Fresh nonvisual review

Pending. One independent reviewer will try to disprove engineering readiness;
all material findings will be adjudicated by the primary.

## Authoritative validation and final Git state

Pending after fixes and review. Historical pass counts are not final evidence.

## External actions and handoff

After engineering passes, Fable/Opus performs the final live visual and interaction
acceptance, including the inherited queue and Premium guard. No repo is promoted
to main by this work. This marker, if earned, will mean engineering readiness
for that gate only, never full product release readiness.
