# Nonvisual engineering closure — 2026-10-11

This is an append-only continuation of the accepted Claude/Opus campaign.
Engineering readiness for the Fable/Opus gate is **YES** following adjudicated
fresh review and authoritative validation below. No main promotion or final
release claim. Historical pending checkpoints are preserved in the root ledger.

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

One fresh read-only nonvisual reviewer independently reproduced four material
findings. Primary accepted each based on source and concrete reproductions,
made minimal fixes and red-first tests, and reviewer reran original probes.
All four passed at Platform `c0c3aa8` and Research `2297cd6`.
The reviewer established no remaining material nonvisual defect. This conclusion
is conditional on authoritative validation and is not visual/release approval.
Full durable report: `NONVISUAL_FRESH_REVIEW_2026-10-11.md`.

| ID | Class | Root cause / correction / proof |
|---|---|---|
| HELPER-DELIVERY-REPOINT | ENGINEERING_P1 | Original-owner retry depended on replacement heartbeat. Retry owed work independently while preserving original trust and bounded attempts. Clear/offline replacement regression and original independent repro pass. Research `f7d9720f67d4b4f8819c1c6040ebb274897b5afc`. |
| PARAM-TYPE-BYPASS | ENGINEERING_P2 | Existing numeric financial bounds vanished for strings/booleans. Require numeric types for bounded inputs; preserve deliberately ignored cash and other established scalar inputs. Red common-validator test; actual mocked backtest POST now 400; Stress request and saved-config cases pass. Platform `c0c3aa83784afa2a21aa4cd517f2cdbe77a20dc5`. |
| PINE-QUARANTINE | ENGINEERING_P2 | Interactive worker financial results bypassed accepted production correction guard. Apply existing guard when a broker is requested, preserve indicator and pure Broker historical reproduction. Red legacy worker repro, green partial/legacy refusal and indicator worker tests. Platform `c0c3aa8`. |
| HELPER-REVOKED-STORAGE | ENGINEERING_P1 | Revoked-owner retirement assumed archive existed even after disk storage failure. Retain before retiring; keep memory/slot and truthful error with delayed retry if storage fails; never send to revoked peer. c4d11 red/green and independent disk-full/revoke/storage-recovery repro pass. Research `2297cd67a209147953710d4d05de487662e69c0c`. |

Research endpoint-race checkpoint `399723f2079aede084b9e77e47daac146d018c60`
binds in-flight presence evidence to peer, host and port. Focused helper suite
at final Research source: **37/37**.

The first authoritative frontend unit run caught a missing reader label for
`feeInclusiveAffordability`: 1521 pass / 1 fail. Preserved the accepted contract,
added only the plain semantic label to the existing mapping; focused export/
provenance tests **5/5**. Platform `296c78b` contains this one-line completion;
no presentation styles, geometry or Premium lock changed.

## Authoritative validation and final Git state

Authoritative checks at the final engineering source (Platform `296c78b`,
Research `2297cd6`, Bot `88a8bfe`):

| Repo / category | Exact configured command | Actual result |
|---|---|---|
| Platform backend | `npm run verify` (lint → typecheck including scripts/tests → full `npm test` → `tsc` build) | 1384/1384; 0 failures, 0 skipped. All static checks/build passed. |
| Platform frontend static | `npm run lint`; `npm run typecheck` | Passed. |
| Platform frontend unit | `npm run test:unit` | 1522/1522; 0 failures, 0 skipped. |
| Platform frontend DOM | `npm run test:dom` | 574/574; 0 failures, 0 skipped. |
| Platform frontend production | `npm run build` | Next.js production build passed; all 15 pages generated. |
| Premium regression lock | `QA_PLAYWRIGHT_FROM=/tmp/trading-nonvisual-20261011/qa/ QA_CHANNEL=chrome QA_BASE=http://localhost:3051 node qa/premiumLock.mjs` (unchanged guard) | 61/61 PASS against the production build and canonical backend; no uncaught page errors. |
| Research Python | `python3 -m unittest discover -s tests -p 'test_*.py'` | 224/224, OK; no skips reported. |
| Research Node | `node --test tests/*.test.mjs` | 101/101; 0 failures, 0 skipped. |
| Research configured CI | `check-docs.sh`, `check-repo-hygiene.sh`, `scan-secrets.sh`, `check-platform-resolver.sh`, configured `bash -n` on four launch scripts | All passed. Additional Python AST syntax check: 53 files passed. |
| Bot backend | `DRY_RUN=true npm run verify` | 385/385; 0 failures, 0 skipped; lint/typecheck/build passed. |
| Bot frontend | `npm run verify` after lockfile `npm ci --no-audit --no-fund` (dependencies initially absent) | 13/13; 0 failures, 0 skipped; lint/typecheck/Vite production build passed. |

The frontend first full unit run was 1521/1522; the missing correction label
was fixed without changing the test, and the authoritative repeat is above.
No backend source changed after its full pass; no Research source changed after
its full pass. Focused runs are overlapping evidence, never added to these totals.

Canonical runtime DB `platform`: `npm run migrate` returned no pending migrations.
Read-only schema verification confirms migration
`047_fractional_backtest_slippage.sql` recorded and both slippage columns `numeric`.
It was already applied when the final migration check ran. No canonical
DB reset. Full backend tests used only the configured test database.

One canonical checkout/runtime used, no database clones or new worktrees.
A temporary production frontend on :3051 used the same canonical backend on
:4000, a fresh Chrome context, and no owner browser profile. It was stopped after
the unchanged guard passed. Existing owner runtime processes were preserved.
Disk 8.5 GiB after build. No credentials changed or real order made.

Final engineering source Platform:
`296c78bedb6e34d602d1b6b1482a86f696b1409c`, equals fetched campaign origin.
Platform engineering cluster:
`2439d43477234cdbe051159d5b0388a017df8160`.
The final documentation-only commit records this acceptance; its exact SHA and
remote equality are recorded in the root campaign ledger and final handoff.

Research continuation `finalization/nonvisual-compute-delivery-20261011`:
`2297cd67a209147953710d4d05de487662e69c0c`, equals fetched origin, clean.
Accepted baseline origin remains
`894e7335e29213f89c9d1ee025090a6a0499463a`.
Bot `finalization/bot-halt-exits-20261011`:
`88a8bfe1125d40f2c955c67c3d098393265d7501`, equals fetched origin, clean.
Platform has only the documented pre-existing eight `graphify-out/` tracked
deletions and intentional untracked `phase2/` after the docs checkpoint.

All local/origin main refs remain unchanged: Platform `ca30f80`, Research
`f6d10e5`, Bot `9286434`. No merge, main push, reset, clean, stash, rebase,
force push, accepted-history rewrite or test weakening.

## External actions and handoff

Fable/Opus must now perform the final live visual and interaction acceptance
against the canonical campaign state, including the inherited queue and unchanged
Premium guard. No known valid P0/P1 or material unresolved P2 engineering finding
remains; deferred/new-scope items have explicit dispositions above.

No external engineering blocker remains. Other deployment targets must apply
migration 047 through the normal migration runner when these commits are later
deployed. This is not an instruction to deploy or promote main now.

Preserve accepted visuals and the tested engineering contracts while conducting
that gate. No repo was promoted to main. Engineering readiness does not imply
final release approval or final Premium-parity acceptance.

ENGINEERING_READY_FOR_FABLE=YES
