# Platform documentation

**Writing a change prompt?** Give Claude chat [CLAUDE_CHAT_BRIEF.md](CLAUDE_CHAT_BRIEF.md). It has the system, its current state, the rules and a prompt template.

**Production state:** [Operations §10](OPERATIONS.md) records what runs now. [BOT-DEPLOY.md](../platform/deployment/aws/BOT-DEPLOY.md) is the execution Bot runbook.

**Owner's feature guide:** [TRADING_SCENE_OWNER_GUIDE.md](TRADING_SCENE_OWNER_GUIDE.md) — what a user can actually do, where, with which options, and how much of it is verified (campaign of 2026-11-01).

**Canonical handoff for Mahamid (V3, 2026-11-09):** [MAHAMID_FINAL_HANDOFF_2026-11-09.md](MAHAMID_FINAL_HANDOFF_2026-11-09.md) — Bot parity, OD-1 to OD-7, contract changes, deployment order, production checklist and honest open items. It supersedes the earlier same-day handoff.

**Acceptance handoff for Mahamid (2026-11-02):** [MAHAMID_HANDOFF_2026-11-02.md](MAHAMID_HANDOFF_2026-11-02.md) — what V2–V4 and the release polish changed, the verified Git state after the 2026-11-02 synchronization, the hands-on acceptance checklist and the product decisions still open.

Start with [Architecture](ARCHITECTURE.md), [Operations](OPERATIONS.md) and [Security posture](SECURITY-POSTURE.md). The [release guides index](FINAL_SYSTEM_GUIDES_INDEX_2026-10-11.md) links the current Backtester, Shariah and Compute Helper guides and their accepted release evidence.

[Packages](PACKAGES.md) describes the investor package ledger, which isn't wired up yet. [Webhook contract](WEBHOOK-CONTRACT.md) describes the Platform-to-Bot wire boundary. [Accounts](ACCOUNTS.md), [Alerts](ALERTS.md), [Shariah universe](SHARIAH-UNIVERSE.md) and [Stress analysis](STRESS-ANALYSIS.md) cover their respective operator workflows. [UI contract](TRADING_SCENE_UI_UX_CONTRACT.md) records accepted interface behavior. Historical handoffs live in [archive](archive/); dated audit ledgers describe what was true at their dates rather than override current source and guides.
