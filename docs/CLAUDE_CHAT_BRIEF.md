# Trading Scene — brief for writing change prompts

**Snapshot:** 2026-11-07, Platform `72ea65f`, Bot `8d70730`, Research `2578f81`.

Give this file to Claude chat. It holds enough context to turn a change idea into
a prompt for Claude Code. Claude chat can't see the code or production, so anything
here can be out of date. Every prompt should tell Claude Code to check the code
first and to say so if this brief is wrong.

This repository is public. Don't add secrets, private keys, passwords, personal
emails or AWS account details to this file.

## 1. Instructions for Claude chat

When I describe a change:

1. Ask only the questions that change what gets built. Otherwise state your
   assumption and continue.
2. Say which repository owns the change (§2). If it crosses a boundary, say so.
3. Write one prompt per independent change, using the template in §9.
4. Name the likely files as starting points, using §6. Don't invent file names,
   routes or settings. If you don't know, tell Claude Code to find out.
5. Describe what I should see when it works, in product terms.
6. Copy the rules from §5 that apply to the change.
7. If the request is really one of the open decisions in §8, point that out and
   ask me to decide before you write the prompt.

## 2. What the system is

Trading Scene is a charting, research and trading workstation. **Platform decides,
Research consumes Platform's engine, and the Bot executes.** The three stay separate
on purpose.

| | Platform | Research | Execution Bot |
|---|---|---|---|
| Purpose | Chart, Screener, alerts, accounts, Shariah, order ticket, Journal, Quick Backtester | Optimizer search, Walk-forward, Replay, Holdout, Stress, Compute Helper | Holds the exchange keys and places Binance Spot orders |
| Repository used here | `MuhammadMuhamid/my-tradingview-clone` (public) | `MuhammadMuhamid/pythoncryptobacktesingsystems` (private) | `MuhammadMuhamid/3commabotclone` (public) |
| Stack | Next.js, Fastify, TypeScript, PostgreSQL/TimescaleDB | Python controller and TypeScript tools | Express, Vite + React, SQLite via Prisma |
| Local ports | Frontend 3000, backend 4000 | Controller 8765, loopback only | 4001 when run beside Platform |
| Holds exchange keys | **Never** | **Never** | Yes, encrypted at rest |

Older docs call these `trading-scene-platform`, `-research` and `-bot` under
`2ms-muzammil`. Those are the same products under another account.

## 3. Production right now

Treat this as a dated snapshot. The maintained copy is
[OPERATIONS §10](OPERATIONS.md).

| Item | State |
|---|---|
| Platform | `72ea65f` at `mytradingview.alphawebstudioz.com`, on AWS `ap-south-1` |
| Bot | `8d70730` at `bot.alphawebstudioz.com`, on its own server |
| Bot safety settings | `DRY_RUN=true`, `BINANCE_TESTNET=true`, `MAINNET_MANUAL_TRADING_ENABLED=false` when deployed |
| Manual trading | On. The Trade panel shows **PAPER SIMULATION** with the testnet account, seen as admin on 2026-11-05 |
| Orders | One simulated $100 BTCUSDT BUY exists. No order has ever been placed on testnet or mainnet |
| Release check | `release.sh gate` passed for this Platform and Bot pair on 2026-11-05 |

Temporary conditions to keep in mind:

- **Old Bot server:** a stopped server tagged `tradingbot` may hold real Binance keys
  and live settings. It must not be started without an explicit decision.
- **Bot backups:** they run every 6 hours to a private S3 bucket. Nothing alerts on a
  failure, no restore has been tested, and the Bot's encryption keys have no copy off
  the server.
- **Database count:** production `/readyz` reports 59 migrations applied, while this
  commit ships 52. None are missing. Where the extra 7 came from hasn't been traced,
  so any migration work should check this first.

## 4. What exists, and how far it is proven

| Area | Who | Status |
|---|---|---|
| Chart: symbols, intervals, styles, 25 drawing tools, indicators, Pine editor, layouts, watchlists, Bar Replay, Compare | Everyone | Tested locally |
| Alerts: sixteen condition families, four frequency modes, web push. They never place orders | Everyone | Tested. Newer families haven't been seen firing on a live market event |
| Screener: needs a separate Python service | Read for everyone | Not run in the campaign (Binance HTTP 451 from that network) |
| Accounts: email, Google or GitHub sign-in, email verification, two-factor sign-in, per-user data, default-deny routes | Everyone | Tested and live. Admin two-factor works in production. Verification emails wait on SES production access. Neither is required until packages exist |
| Shariah screening: review pack, external research, JSON import, publish, Mode | Admin manages, others read | Walked through locally with fixture data. It validates a file's shape and doesn't issue rulings |
| Manual trading: Binance Spot, MARKET/LIMIT, optional TP/SL | Admin only | Tested with fakes. Panel seen in production. No exchange order yet |
| Journal | Admin only | Tested locally |
| Bot section (`/bot`): read-only bots, open trades and history | Admin only | Tested, and seen working in production as admin |
| Automations: strategy signals to the Bot, 3Commas or paper | Admin only | The Holdout gate has never passed. It only guards the `replace_*.mjs` deploy scripts, and the deployments API route doesn't check it |
| Quick Backtester: `ma_rr_v9`, `srtrend_v10`, `mtf_lean` | Admin only | Tested locally |
| Research Optimizer | Whoever runs it on that Mac | Search and Replay tested locally. Walk-forward and Holdout took 0 trades in a synthetic run at shipped sizing |
| Compute Helper: one job type, `full3y1h` replay | Research operator | Proven on one Mac only |

Limits that surprise people:

- The ticket offers **testnet accounts only**. Real-money orders need a code change
  as well as the Bot's mainnet setting.
- TP/SL is a 30-second Bot poll that sells at market. Nothing rests on the exchange,
  so positions are unprotected while the Bot is down.
- With `DRY_RUN=true`, orders are simulated and don't reach Binance, even testnet.
- Trading is for the administrator. Each user connecting their own exchange account
  would be a new product feature.
- Passing tests or backtests don't show a strategy is profitable.

## 5. Rules for every prompt

Include the rules that apply:

- Check the current code before changing anything. Where this brief and the code
  disagree, the code wins, and say so.
- Never print, commit or ask me to paste secrets, API keys or tokens.
- Never move exchange keys or order placement into Platform or Research, and never
  merge the repositories.
- Don't enable live trading: leave `MAINNET_MANUAL_TRADING_ENABLED` alone, and don't
  change `DRY_RUN` unless the prompt is specifically about that step.
- Don't start the old `tradingbot` server. Don't rotate Binance keys as routine work.
- Selling or reducing a position must stay available under a halt or Shariah block.
- Don't commit, push, merge or deploy unless the prompt says to. Deploys are manual.
- Don't run migrations against an unconfirmed database.
- **Webhook contract:** `webhookContract.ts` and `realizationEventContract.ts` are
  vendored byte-for-byte in Platform and Bot. Change both copies and
  `docs/WEBHOOK-CONTRACT.md` together, then run the release gate.
- **Interface changes:** read `docs/TRADING_SCENE_UI_UX_CONTRACT.md` first. The main
  chart is the visual reference, and shared primitives live in `components/ui.tsx`.
- **New backend routes** are admin-only unless deliberately listed in `userMayReach`.
- Add or update tests, and update the docs the change makes wrong.
- Report honestly what was run and what wasn't. Never describe a fake or fixture run
  as verified against an exchange.

## 6. Where things live

Paths are starting points, relative to each repository.

| Change is about | Look in |
|---|---|
| Pages | Platform `platform/frontend/app/` (`chart`, `alerts`, `journal`, `operations`, `optimizers`, `profile`, `research`, `screener`, `shariah`, `stress`, `trading`) |
| Order ticket | Platform `platform/frontend/components/tv/ManualTradingPanel.tsx` |
| Navigation and role visibility | Platform `platform/frontend/lib/navigation.ts`, `components/AdminOnlyPage.tsx` |
| API routes | Platform `platform/backend/src/api/routes/` |
| Platform-to-Bot trading | Platform `platform/backend/src/manualTrading/`, `api/routes/manualTrading.ts`; Bot `backend/src/services/manualTrading.ts` |
| Bot section | Platform `platform/frontend/app/bot/page.tsx`, `platform/backend/src/api/routes/botView.ts`; Bot `backend/src/services/botView.ts` |
| Email, two-factor and GitHub | Platform `platform/backend/src/api/routes/accountSecurity.ts`, `security/twoFactor.ts`, `security/github.ts`, `email/mailer.ts`, `platform/frontend/components/AccountSecurity.tsx` |
| Who may reach what | Platform `platform/backend/src/security/requestUser.ts` |
| Alerts | Platform `platform/backend/src/alerts/`, `api/routes/maAlerts.ts` |
| Shariah | Platform `platform/backend/src/shariah/`; Bot `backend/src/services/shariah.ts` |
| Strategy and backtest engine | Platform `platform/backend/src/engine/`, `ta/` |
| Pine | Platform `platform/backend/src/pine/` |
| Database migrations | Platform `platform/backend/src/db/migrations/` |
| Scanner service | Platform `platform/screener/` |
| Binance calls | Bot `backend/src/services/binance.ts` |
| Production deployment | Platform `platform/deployment/aws/` |
| Optimizer trees | Research `trees/`, `shared/`, `backtester/` |

## 7. Checks

```bash
# Platform: run in platform/backend and in platform/frontend
npm run verify

# Platform repository root
bash scripts/ci/check-docs.sh
bash scripts/ci/scan-secrets.sh
bash scripts/ci/check-repo-hygiene.sh

# After anything touching the Platform and Bot boundary
platform/scripts/release.sh gate --peer-bot-root <path-to-bot>
```

The Bot and Research READMEs list their own checks. Tests don't need a database or
network unless a test file says otherwise, and must never use a real key.

## 8. Open items

**Decisions for the people running the project. Ask before building:**

- Is this operator software, or a product where each user trades on their own account?
- May Shariah Mode show ON when the Bot control channel isn't armed? Today it can,
  and it says *not armed*.
- Should Stress refuse windows with missing candles, or keep disclosing them?
- Should a blocked distributed run get a re-open action, or stay clone-only?
- How strong should data-coverage checks be across all the feeds a strategy reads?
- Who owns the Shariah research method and sign-off?

**Next verification steps, in order:**

1. Test a Bot restore, and keep a separate copy of its encryption keys.
2. Test real testnet orders with `DRY_RUN=false`: halts, Shariah refusals, TP/SL and
   a Bot restart.
3. Decide what happens to the old Bot server.

**Known tooling gap:** the `launch` safety check in `bot-stack.sh` only looks for an
instance tagged `signal-bot`, so it doesn't catch the old `tradingbot` server.

**Never proven:** a testnet or mainnet order, exchange-native stops (the code has no
call sites), Google sign-in, Bot-connected Shariah enforcement, a second physical Mac
for Compute Helper, and Walk-forward or Holdout on real data.

## 9. Prompt template

```text
Goal: <one sentence, in product terms>
Repository: <Platform / Bot / Research, and whether the change crosses a boundary>
Start from: <likely files from the brief; say they need checking>

Current behaviour: <what happens now>
Wanted behaviour: <what should happen, including who sees it and error or empty states>
Out of scope: <what must not change>

Rules:
- Read the current code first. Tell me if the brief's description of it is wrong.
- <the rules from §5 that apply>

Done means:
- <what I can see or do when it works>
- <tests added or updated, and the checks from §7 that must pass>
- Docs the change makes wrong are updated.

Report back: what changed, what you ran and the results, what you didn't verify.
Don't commit, push or deploy until I ask.
```

## 10. Which docs to attach

This brief is enough for most small changes. Attach more for bigger ones:

| Change type | Attach |
|---|---|
| Any product behaviour | [Owner's guide](TRADING_SCENE_OWNER_GUIDE.md) |
| Interface | [UI/UX contract](TRADING_SCENE_UI_UX_CONTRACT.md) |
| System design | [Architecture](ARCHITECTURE.md), [Security posture](SECURITY-POSTURE.md) |
| Platform-to-Bot | [Webhook contract](WEBHOOK-CONTRACT.md), Bot `README.md` |
| Deploys or production | [Operations](OPERATIONS.md), [Bot deployment](../platform/deployment/aws/BOT-DEPLOY.md), [AWS deployment](../platform/deployment/aws/README.md) |
| Alerts | [Alerts](ALERTS.md) |
| Accounts or permissions | [Accounts](ACCOUNTS.md) |
| Shariah | [Shariah guide](FINAL_SYSTEM_GUIDE_SHARIAH_2026-10-11.md), [Shariah universe](SHARIAH-UNIVERSE.md) |
| Stress or backtesting | [Stress analysis](STRESS-ANALYSIS.md), [Backtester guide](FINAL_SYSTEM_GUIDE_BACKTESTER_2026-10-11.md) |
| Compute Helper | [Compute Helper guide](FINAL_SYSTEM_GUIDE_COMPUTE_HELPER_2026-10-11.md) |
| Product decisions and acceptance | [Handoff of 2026-11-02](MAHAMID_HANDOFF_2026-11-02.md), which is dated and predates the production Bot |

Don't treat `CLAUDE_HANDOFF.md`, `docs/archive/`, `evidence/` or the dated audit
files as current. They record what was true on their dates.
