# Packages and cohorts

**Status:** the ledger, calendar, rules, API and the administrator's page (Trading →
Packages, `/packages`) and members' page (`/portfolio`, from *My portfolio* in the account
menu) exist and are tested. Live trading doesn't use any of it yet. Wiring it into
order sizing is a separate change.

Plan: `MULTIUSER_BOT_MASTER_PROMPT_v2.md` (kept outside this repository), with the
owner's decisions of 2026-11-05 and 2026-11-07.

## The model

- **A package** is one strategy run on several coins, one deployment per coin. It has
  a term (half-month, month, quarter or half-year), a minimum deposit, and the
  percentage of free equity each BUY spends.
- **A cohort** is one run of a package. A package runs one cohort at a time, back to
  back, on calendar boundaries in Asia/Karachi (UTC+5, no daylight saving):

  | Term | Cohorts |
  |---|---|
  | Half-month | 1st to 15th, then 16th to month end |
  | Month | Each calendar month |
  | Quarter | 3 calendar months |
  | Half-year | 6 calendar months |

- **Members** ask to join a cohort, and the administrator approves them. The
  administrator then records each deposit after checking it arrived. The app moves
  no money.
- **The deadline** for a deposit is the cohort's start: Karachi midnight, which is 19:00
  UTC the day before. A later deposit is refused unless the administrator records a
  reason, and that reason is audited.
- **Shares** are fixed when the cohort starts: each member's capital divided by the
  cohort's opening capital. A cohort with no money is cancelled.

## How the money works

- **The ledger:** every balance comes from `ledger_entries`, where triggers refuse
  UPDATE, DELETE and TRUNCATE, so corrections are new `ADJUSTMENT` entries with a note.
- **No double counting:** each entry has an idempotency key, so recording the same deposit
  or trade result twice counts once, and reusing a key for a different amount is refused.
- **Exact amounts:** money is NUMERIC(38,8) in PostgreSQL and a bigint of 10^-8 units in code
  (`platform/backend/src/packages/money.ts`), never a float. `db/pool.ts` parses NUMERIC as a
  float, so the ledger casts every money column to text when it reads it.
- **Splitting value:** a member's value is the cohort's value split by capital, with leftover
  units handed out deliberately, so members' values always add up to the cohort's exactly.
- **No fees** for now. No interest, no projected returns.
- **Accounts with money:** an account with a membership can't be deleted, because its
  ledger entries reference it.

## Trades and the carry rule

- **Sizing a BUY:** the deployment's BUY goes to its package's running cohort, sized at
  the package's percentage of equity not already in open trades, rounded down to a cent.
- **When a cohort ends:** it stops opening trades and becomes **settling**. Trades it holds
  stay with it until they close. When none are left, it becomes **settled** and its
  closing value is fixed. Only then can members withdraw, up to their value.
- **The carry rule:** while a settling cohort holds a coin, the running cohort skips BUYs
  for that coin ("held by settling cohort"). So a package holds at most one position per
  coin, and a SELL always has exactly one owner.

## Exchange account

All packages trade on one Binance account (owner decision, 2026-11-07). Each package
should have its own Bot "bot", with its own webhook, on that account, so its positions
stay separate in the Bot. Balances can only be checked against the exchange as a total
across all packages.

## The scheduler

`platform/backend/src/packages/scheduler.ts` runs every minute inside the backend. It
moves no money and places no orders.

1. **Advancing cohorts.** It moves each cohort that is due:
   - from open to running at its start, or to cancelled if no money was recorded;
   - from running to settling or settled at its end;
   - from settling to settled once the last trade closes.
2. **Scheduling ahead.** It keeps each **active** package two terms ahead, so members can
   always see the next term and its deadline. A paused or closed package gets no new
   terms, but its existing cohorts still run to the end.

It calls the same functions as the administrator's buttons, so every rule applies
either way. It's safe to run twice. A database lock lets only one Platform instance run
it at a time. `PACKAGE_SCHEDULER_ENABLED=false` turns it off; the default is on.

## API

`platform/backend/src/api/routes/packages.ts`.

**Administrator only,** under `/api/admin`:
- create packages, attach deployments, and schedule the next cohort;
- approve or reject requests, or add a member by email;
- record deposits and withdrawals;
- read a cohort's members, entries and trades, and the audit log.

Recording money and changing a package's status ask for the administrator's code from
their authenticator app, or their password if two-factor is off. Guesses count against
the same per-account limit as sign-in.

**Members** can use three routes:
- `GET /api/packages` lists active packages and the cohort each is taking members for. It
  shows the deposit instructions but not the sizing.
- `POST /api/packages/cohorts/:id/join` asks to join, and needs a verified email and
  two-factor sign-in.
- `GET /api/portfolio` shows only the member's own requests and holdings.

## Not built yet

- Sending the planned quote amount on live orders, and skipping BUYs the carry rule
  refuses. This touches the live order path and needs its own review.
- Recording trade results from the Bot. Realization events are off by default, and their
  fees are estimated at 0.1%, not read from the exchange, so members' values would be
  estimates until that changes.
- Reconciliation against the exchange. Until the scheduler exists, the administrator
  schedules cohorts and presses *Update status* on the Packages page.
- Force-closing a settling cohort's trade.
