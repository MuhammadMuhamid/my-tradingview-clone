# Trading Scene — Final Documentation Index (2026-10-11)

This index records the 2026-10-11 accepted release. For the current architecture,
operations and security entry point, start at [README.md](README.md). The dated
acceptance report records release-time branches and checks; the current hardening
report in the workspace records the later promotion. Current source and the
current security posture take precedence where behavior has since been hardened.

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
| [SECURITY-POSTURE.md](SECURITY-POSTURE.md) | Current trust boundaries, signing, secret handling and deployment checks. |
| [SHARIAH-UNIVERSE.md](SHARIAH-UNIVERSE.md) · [STRESS-ANALYSIS.md](STRESS-ANALYSIS.md) · [CANDLE-PERFORMANCE.md](CANDLE-PERFORMANCE.md) | Subsystem design notes cited by code and tests. |
| [TRADING_SCENE_BROWSER_PARITY.md](TRADING_SCENE_BROWSER_PARITY.md) | How the parity browsers and profiles are run. |
| [REMEDIATION-LEDGER.md](REMEDIATION-LEDGER.md) · [SECURITY-AUDIT-2026-08-31.md](SECURITY-AUDIT-2026-08-31.md) · [BE-08-VALIDATION.md](BE-08-VALIDATION.md) · [TRADINGVIEW_CHART_PARITY_LEDGER.md](TRADINGVIEW_CHART_PARITY_LEDGER.md) | Audit ledgers and validation records cited by code, tests and CI. |
| [archive/](archive/) | Superseded 2026-09-18 handoffs, kept for history only. |

## Repositories and branches at this dated acceptance

| Repository | Branch | Role |
|---|---|---|
| Platform (`v2-campaign/platform`) | `main` (promoted from `finalization/mahamid-reconcile-premium-parity-20260918`, see acceptance report) | Decides: UI, backtests, alerts, Shariah, risk, execution intents. |
| Research (`v2-campaign/research`) | `finalization/nonvisual-compute-delivery-20261011` | Research Backtester, optimisers, distributed replay, Compute Helper. This row records the branch at this acceptance; later promotion is in the hardening report. |
| Bot (`v2-campaign/bot`) | `finalization/bot-halt-exits-20261011` | Executes: final Shariah/halt gate before Binance. This row records the branch at this acceptance; later promotion is in the hardening report. |

The durable campaign ledger is outside the repository:
`/Users/m/Desktop/Trading-Codex-V3/FINAL_PREMIUM_PARITY_RECONCILIATION_STATE.md`.
