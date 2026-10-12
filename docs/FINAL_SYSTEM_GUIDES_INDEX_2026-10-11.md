# Trading Scene — Final Documentation Index (2026-10-11)

Start here. These documents describe the released product as the code actually behaves on the
Platform release commit recorded in the acceptance report. Where any older document disagrees,
these, and the current source, win.

## Final release documents

| Document | What it answers |
|---|---|
| [FINAL_RELEASE_ACCEPTANCE_2026-10-11.md](FINAL_RELEASE_ACCEPTANCE_2026-10-11.md) | Is it ready, on what evidence: Git state, visual and interaction acceptance, defects fixed, validation counts, cleanup, main promotion, external actions. |
| [FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md](FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md) | How a backtest is created, validated, simulated and reported: fills, fees (MONEY-FEE), impossible fills (MONEY-FILL), metrics, windows, Stress, versioning, reproducibility. |
| [FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md](FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md) | The controlled screening workflow (pack → external research → validated import → publication → enforcement), the status model, BUY vs SELL, outages (SHARIAH-EXIT-OUTAGE) and import concurrency (SHARIAH-IMPORT-RACE). |
| [FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md) | The donating-Mac worker for the Research Backtester: pairing, presence (HELPER-PRESENCE), assignment, delivery, retention (HELPER-DELIVERY/OWNER, HELPER-DELIVERY-REPOINT, HELPER-REVOKED-STORAGE). |

## Engineering closure evidence (still authoritative for what it covers)

| Document | Scope |
|---|---|
| [NONVISUAL_ENGINEERING_CLOSURE_2026-10-11.md](NONVISUAL_ENGINEERING_CLOSURE_2026-10-11.md) | Money, Stress, Shariah exit, gate persistence, Helper delivery fixes; their red-first proofs and validation. |
| [NONVISUAL_FRESH_REVIEW_2026-10-11.md](NONVISUAL_FRESH_REVIEW_2026-10-11.md) | The independent reviewer's reproductions of those fixes. |

## Standing references

| Document | Scope |
|---|---|
| [TRADING_SCENE_UI_UX_CONTRACT.md](TRADING_SCENE_UI_UX_CONTRACT.md) | Visual and interaction authority (tokens, density, control states, symbol display). |
| [PREMIUM_GOLDEN_EVIDENCE.md](PREMIUM_GOLDEN_EVIDENCE.md) | Golden evidence behind the Premium regression lock (`platform/frontend/qa/premiumLock.mjs`). |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [OPERATIONS.md](OPERATIONS.md) · [ALERTS.md](ALERTS.md) · [WEBHOOK-CONTRACT.md](WEBHOOK-CONTRACT.md) | System ownership, operator console and halt, alerts, Platform→Bot contract. |
| [SHARIAH-UNIVERSE.md](SHARIAH-UNIVERSE.md) · [STRESS-ANALYSIS.md](STRESS-ANALYSIS.md) · [CANDLE-PERFORMANCE.md](CANDLE-PERFORMANCE.md) | Subsystem design notes cited by code and tests. |
| [TRADING_SCENE_BROWSER_PARITY.md](TRADING_SCENE_BROWSER_PARITY.md) | How the parity browsers and profiles are run. |
| [REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md) · [SECURITY-AUDIT-2026-08-31.md](SECURITY-AUDIT-2026-08-31.md) · [BE-08-VALIDATION.md](BE-08-VALIDATION.md) · [TRADINGVIEW_CHART_PARITY_LEDGER.md](TRADINGVIEW_CHART_PARITY_LEDGER.md) | Audit ledgers and validation records cited by code, tests and CI. |
| [archive/](archive/) | Superseded 2026-09-18 handoffs, kept for history only. |

## Repositories and accepted branches

| Repository | Branch | Role |
|---|---|---|
| Platform (`v2-campaign/platform`) | `main` (promoted from `finalization/mahamid-reconcile-premium-parity-20260918`, see acceptance report) | Decides: UI, backtests, alerts, Shariah, risk, execution intents. |
| Research (`v2-campaign/research`) | `finalization/nonvisual-compute-delivery-20261011` | Research Backtester, optimisers, distributed replay, Compute Helper. Not promoted to `main` by this release. |
| Bot (`v2-campaign/bot`) | `finalization/bot-halt-exits-20261011` | Executes: final Shariah/halt gate before Binance. Not promoted to `main` by this release. |

The durable campaign ledger is outside the repository:
`/Users/m/Desktop/Trading-Codex-V3/FINAL_PREMIUM_PARITY_RECONCILIATION_STATE.md`.
