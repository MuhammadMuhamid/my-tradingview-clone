/**
 * Packages, cohorts, memberships and their ledger.
 *
 * Every money-changing call runs in one transaction that locks the cohort row
 * first, so a deposit can't land while the same cohort is starting, and a trade
 * result can't land while it's settling. Every one takes an idempotency key.
 */
import type { PoolClient } from "pg";
import { pool, query } from "../db/pool";
import { firstWindowFrom, nextWindow, type Term } from "../packages/calendar";
import { formatMoney, parseMoney, type Units } from "../packages/money";
import {
  buyQuote, decideBuy, decideSell, equityFrom, memberValues, nextStatus, withdrawable,
  type CohortStatus, type HeldPosition,
} from "../packages/cohortRules";

export class PackageRuleError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

interface CohortRow {
  id: string; package_id: string; starts_at: Date; ends_at: Date; deposit_cutoff_at: Date;
  status: CohortStatus; opening_capital: string | null; closing_value: string | null;
}

/**
 * Money columns come back as text. The pool parses NUMERIC as a float
 * (`db/pool.ts`), which would round a ledger amount, so every money read here
 * casts to text first.
 */
const COHORT_COLUMNS = `id, package_id, starts_at, ends_at, deposit_cutoff_at, status,
  opening_capital::text AS opening_capital, closing_value::text AS closing_value`;

async function lockCohort(client: PoolClient, cohortId: string): Promise<CohortRow> {
  const { rows } = await client.query<CohortRow>(`SELECT ${COHORT_COLUMNS} FROM cohorts WHERE id = $1 FOR UPDATE`, [cohortId]);
  if (!rows[0]) throw new PackageRuleError("cohort not found", 404);
  return rows[0];
}

async function audit(client: PoolClient, actor: string | null, action: string, target: string, detail: object): Promise<void> {
  await client.query("INSERT INTO admin_audit (actor, action, target, detail) VALUES ($1, $2, $3, $4)",
    [actor, action, target, JSON.stringify(detail)]);
}

/** Adds an entry, or returns the existing one if this key was already recorded. */
async function appendEntry(client: PoolClient, entry: {
  cohortId: string; membershipId: string | null; kind: string; amount: Units;
  sourceType?: string; sourceId?: string; idempotencyKey: string; note?: string; actor: string | null;
}): Promise<{ id: string; created: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ledger_entries (cohort_id, membership_id, kind, amount, source_type, source_id,
                                 idempotency_key, note, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [entry.cohortId, entry.membershipId, entry.kind, formatMoney(entry.amount), entry.sourceType ?? null,
      entry.sourceId ?? null, entry.idempotencyKey, entry.note ?? "", entry.actor],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = await client.query<{ id: string; cohort_id: string; kind: string; amount: string }>(
    "SELECT id, cohort_id, kind, amount::text AS amount FROM ledger_entries WHERE idempotency_key = $1", [entry.idempotencyKey]);
  const row = existing.rows[0]!;
  if (row.cohort_id !== entry.cohortId || row.kind !== entry.kind || parseMoney(row.amount) !== entry.amount) {
    throw new PackageRuleError("this idempotency key was already used for a different entry");
  }
  return { id: row.id, created: false };
}

async function cohortEquity(client: PoolClient, cohortId: string): Promise<Units> {
  const { rows } = await client.query<{ amount: string }>(
    "SELECT amount::text AS amount FROM ledger_entries WHERE cohort_id = $1", [cohortId]);
  return equityFrom(rows.map((r) => ({ amount: parseMoney(r.amount) })));
}

// ── packages and their cohorts ──────────────────────────────────────────────

export async function createPackage(input: {
  name: string; description?: string; term: Term; minAmount: string; tradePercent: string;
  joinInstructions?: string; actor: string;
}): Promise<string> {
  return inTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO packages (name, description, term, min_amount, trade_percent, join_instructions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.name.trim(), input.description ?? "", input.term, formatMoney(parseMoney(input.minAmount)),
        formatMoney(parseMoney(input.tradePercent)), input.joinInstructions ?? "", input.actor],
    );
    await audit(client, input.actor, "package.create", rows[0]!.id, { name: input.name, term: input.term });
    return rows[0]!.id;
  });
}

export async function attachDeployment(packageId: string, deploymentId: string, actor: string): Promise<void> {
  await inTransaction(async (client) => {
    await client.query("INSERT INTO package_deployments (package_id, deployment_id) VALUES ($1, $2)", [packageId, deploymentId]);
    await audit(client, actor, "package.attach_deployment", packageId, { deploymentId });
  });
}

/** The package's next cohort after its latest one, or its first from `from`. */
export async function scheduleNextCohort(packageId: string, from: Date): Promise<string> {
  return inTransaction(async (client) => {
    const pkg = await client.query<{ term: Term }>("SELECT term FROM packages WHERE id = $1 FOR UPDATE", [packageId]);
    if (!pkg.rows[0]) throw new PackageRuleError("package not found", 404);
    const last = await client.query<{ ends_at: Date }>(
      "SELECT ends_at FROM cohorts WHERE package_id = $1 AND status <> 'cancelled' ORDER BY starts_at DESC LIMIT 1",
      [packageId]);
    const window = last.rows[0] && last.rows[0].ends_at.getTime() >= from.getTime()
      ? nextWindow(pkg.rows[0].term, last.rows[0].ends_at)
      : firstWindowFrom(pkg.rows[0].term, from);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cohorts (package_id, starts_at, ends_at, deposit_cutoff_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [packageId, window.startsAt, window.endsAt, window.depositCutoffAt]);
    return rows[0]!.id;
  });
}


// ── members and their money ─────────────────────────────────────────────────

export async function requestMembership(userId: string, cohortId: string, now = new Date()): Promise<string> {
  return inTransaction(async (client) => {
    const cohort = await lockCohort(client, cohortId);
    if (cohort.status !== "open" || now >= cohort.deposit_cutoff_at) {
      throw new PackageRuleError("This cohort isn't taking new members. Choose the next one.");
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memberships (cohort_id, user_id) VALUES ($1, $2)
       ON CONFLICT (cohort_id, user_id) DO UPDATE SET cohort_id = EXCLUDED.cohort_id RETURNING id`,
      [cohortId, userId]);
    return rows[0]!.id;
  });
}

export async function decideMembership(membershipId: string, approve: boolean, actor: string): Promise<void> {
  await inTransaction(async (client) => {
    const { rows } = await client.query<{ cohort_id: string; status: string }>(
      "SELECT cohort_id, status FROM memberships WHERE id = $1", [membershipId]);
    if (!rows[0]) throw new PackageRuleError("membership not found", 404);
    await lockCohort(client, rows[0].cohort_id);
    if (rows[0].status !== "requested") throw new PackageRuleError(`This request was already ${rows[0].status}.`);
    await client.query("UPDATE memberships SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1",
      [membershipId, approve ? "approved" : "rejected", actor]);
    await audit(client, actor, approve ? "membership.approve" : "membership.reject", membershipId, {});
  });
}

/**
 * The administrator records money they've checked arrived. It counts for the
 * cohort only before the cohort starts, unless they give a reason to override.
 */
export async function recordDeposit(input: {
  membershipId: string; amount: string; reference: string; note?: string; actor: string;
  idempotencyKey: string; lateReason?: string; now?: Date;
}): Promise<{ entryId: string; created: boolean }> {
  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new PackageRuleError("A deposit must be more than zero.", 400);
  const now = input.now ?? new Date();
  return inTransaction(async (client) => {
    const membership = await client.query<{ cohort_id: string; status: string; min_amount: string }>(
      `SELECT m.cohort_id, m.status, p.min_amount::text AS min_amount FROM memberships m
         JOIN cohorts c ON c.id = m.cohort_id JOIN packages p ON p.id = c.package_id WHERE m.id = $1`,
      [input.membershipId]);
    const row = membership.rows[0];
    if (!row) throw new PackageRuleError("membership not found", 404);
    const cohort = await lockCohort(client, row.cohort_id);
    if (row.status !== "approved") throw new PackageRuleError("Approve the membership before recording money.");
    if (cohort.status !== "open") throw new PackageRuleError("This cohort has already started. Record the deposit in the next one.");
    if (now >= cohort.deposit_cutoff_at && !input.lateReason?.trim()) {
      throw new PackageRuleError("The deposit deadline has passed. Record it in the next cohort, or give a reason to override.");
    }
    const result = await appendEntry(client, {
      cohortId: row.cohort_id, membershipId: input.membershipId, kind: "CAPITAL_IN", amount,
      sourceType: "deposit", sourceId: input.reference, idempotencyKey: input.idempotencyKey,
      note: input.note, actor: input.actor,
    });
    if (result.created) {
      await audit(client, input.actor, "deposit.record", input.membershipId, {
        amount: formatMoney(amount), reference: input.reference, late: now >= cohort.deposit_cutoff_at,
        lateReason: input.lateReason ?? null, belowMinimum: amount < parseMoney(row.min_amount),
      });
    }
    return { entryId: result.id, created: result.created };
  });
}

/** Moves a cohort along its lifecycle, fixing opening capital and closing value as it goes. */
export async function advanceCohort(cohortId: string, now = new Date()): Promise<CohortStatus> {
  return inTransaction(async (client) => {
    const cohort = await lockCohort(client, cohortId);
    const open = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM cohort_trades WHERE cohort_id = $1 AND status = 'open'", [cohortId]);
    let status = nextStatus({ status: cohort.status, now, startsAt: cohort.starts_at, endsAt: cohort.ends_at,
      openTrades: Number(open.rows[0]!.n) });
    if (status === cohort.status) return status;
    if (status === "running") {
      const capital = await cohortEquity(client, cohortId);
      // A cohort with no money has nothing to run.
      if (capital <= 0n) status = "cancelled";
      await client.query("UPDATE cohorts SET status = $2, opening_capital = $3 WHERE id = $1",
        [cohortId, status, formatMoney(capital)]);
    } else if (status === "settled") {
      const value = await cohortEquity(client, cohortId);
      await client.query("UPDATE cohorts SET status = 'settled', closing_value = $2 WHERE id = $1",
        [cohortId, formatMoney(value)]);
    } else {
      await client.query("UPDATE cohorts SET status = $2 WHERE id = $1", [cohortId, status]);
    }
    return status;
  });
}

// ── trades ──────────────────────────────────────────────────────────────────

async function heldPositions(client: PoolClient, packageId: string): Promise<HeldPosition[]> {
  const { rows } = await client.query<{ cohort_id: string; status: CohortStatus; symbol: string }>(
    `SELECT t.cohort_id, c.status, t.symbol FROM cohort_trades t JOIN cohorts c ON c.id = t.cohort_id
      WHERE c.package_id = $1 AND t.status = 'open'`, [packageId]);
  return rows.map((r) => ({ cohortId: r.cohort_id, cohortStatus: r.status, symbol: r.symbol }));
}

/**
 * What a deployment's BUY should do for its package: which cohort it's for and
 * the quote amount, or why it's skipped.
 */
export async function planBuy(deploymentId: string, symbol: string):
  Promise<{ cohortId: string; quote: string } | { skip: string } | null> {
  return inTransaction(async (client) => {
    const pkg = await client.query<{ package_id: string; trade_percent: string }>(
      `SELECT pd.package_id, p.trade_percent::text AS trade_percent FROM package_deployments pd JOIN packages p ON p.id = pd.package_id
        WHERE pd.deployment_id = $1`, [deploymentId]);
    if (!pkg.rows[0]) return null;
    const running = await client.query<{ id: string }>(
      "SELECT id FROM cohorts WHERE package_id = $1 AND status = 'running' FOR UPDATE", [pkg.rows[0].package_id]);
    const decision = decideBuy({ symbol, runningCohortId: running.rows[0]?.id ?? null,
      held: await heldPositions(client, pkg.rows[0].package_id) });
    if (!decision.open) return { skip: decision.reason };
    const exposure = await client.query<{ spent: string | null }>(
      "SELECT sum(quote_spent)::text AS spent FROM cohort_trades WHERE cohort_id = $1 AND status = 'open'", [decision.cohortId]);
    const quote = buyQuote({ equity: await cohortEquity(client, decision.cohortId),
      openExposure: parseMoney(exposure.rows[0]!.spent ?? "0"), tradePercent: parseMoney(pkg.rows[0].trade_percent) });
    return quote > 0n ? { cohortId: decision.cohortId, quote: formatMoney(quote) } : { skip: "no free equity" };
  });
}

export async function recordTradeOpen(input: {
  cohortId: string; deploymentId: string; symbol: string; orderIntentId: number | null; quoteSpent: string;
}): Promise<string> {
  return inTransaction(async (client) => {
    const cohort = await lockCohort(client, input.cohortId);
    if (cohort.status !== "running") throw new PackageRuleError("Only a running cohort opens trades.");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO cohort_trades (cohort_id, deployment_id, symbol, order_intent_id, quote_spent)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.cohortId, input.deploymentId, input.symbol, input.orderIntentId, formatMoney(parseMoney(input.quoteSpent))]);
    return rows[0]!.id;
  });
}

/** Which cohort a SELL for this symbol closes for, if any. */
export async function planSell(deploymentId: string, symbol: string): Promise<string | null> {
  const { rows } = await query<{ package_id: string }>(
    "SELECT package_id FROM package_deployments WHERE deployment_id = $1", [deploymentId]);
  if (!rows[0]) return null;
  const client = await pool.connect();
  try { return decideSell(symbol, await heldPositions(client, rows[0].package_id)); }
  finally { client.release(); }
}

/** A closed trade's realized result goes to the cohort that held it. */
export async function recordTradeClose(input: {
  cohortTradeId: string; pnl: string; sourceType: string; sourceId: string; idempotencyKey: string;
}): Promise<void> {
  await inTransaction(async (client) => {
    const trade = await client.query<{ cohort_id: string; status: string }>(
      "SELECT cohort_id, status FROM cohort_trades WHERE id = $1", [input.cohortTradeId]);
    if (!trade.rows[0]) throw new PackageRuleError("trade not found", 404);
    const cohort = await lockCohort(client, trade.rows[0].cohort_id);
    if (cohort.status === "settled") throw new PackageRuleError("This cohort has settled; its results are final.");
    await appendEntry(client, {
      cohortId: trade.rows[0].cohort_id, membershipId: null, kind: "TRADE_PNL", amount: parseMoney(input.pnl),
      sourceType: input.sourceType, sourceId: input.sourceId, idempotencyKey: input.idempotencyKey, actor: null,
    });
    await client.query("UPDATE cohort_trades SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open'",
      [input.cohortTradeId]);
  });
}

// ── what each member is worth ───────────────────────────────────────────────

async function membersOf(client: PoolClient, cohortId: string) {
  const { rows } = await client.query<{ membership_id: string; user_id: string; capital_in: string; paid_out: string }>(
    `SELECT m.id AS membership_id, m.user_id,
            COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'CAPITAL_IN'), 0)::text AS capital_in,
            COALESCE(-sum(e.amount) FILTER (WHERE e.kind = 'CAPITAL_OUT'), 0)::text AS paid_out
       FROM memberships m LEFT JOIN ledger_entries e ON e.membership_id = m.id
      WHERE m.cohort_id = $1 AND m.status = 'approved'
      GROUP BY m.id, m.user_id ORDER BY m.requested_at, m.id`, [cohortId]);
  return rows.map((r) => ({ membershipId: r.membership_id, userId: r.user_id,
    capitalIn: parseMoney(r.capital_in), paidOut: parseMoney(r.paid_out) }));
}

/**
 * Each member's share of the cohort's value before payouts. Running: today's
 * realized equity. Settled: the closing value. Values add up exactly.
 */
async function valuesOf(client: PoolClient, cohort: CohortRow) {
  const members = await membersOf(client, cohort.id);
  const paidOut = members.reduce((a, m) => a + m.paidOut, 0n);
  const base = cohort.status === "settled" && cohort.closing_value !== null
    ? parseMoney(cohort.closing_value) : (await cohortEquity(client, cohort.id)) + paidOut;
  const values = memberValues(base, members.map((m) => m.capitalIn));
  return members.map((m, i) => ({ ...m, value: values[i]! }));
}

export async function recordWithdrawal(input: {
  membershipId: string; amount: string; reference: string; actor: string; idempotencyKey: string; note?: string;
}): Promise<void> {
  const amount = parseMoney(input.amount);
  if (amount <= 0n) throw new PackageRuleError("A withdrawal must be more than zero.", 400);
  await inTransaction(async (client) => {
    const m = await client.query<{ cohort_id: string }>("SELECT cohort_id FROM memberships WHERE id = $1", [input.membershipId]);
    if (!m.rows[0]) throw new PackageRuleError("membership not found", 404);
    const cohort = await lockCohort(client, m.rows[0].cohort_id);
    const member = (await valuesOf(client, cohort)).find((v) => v.membershipId === input.membershipId);
    if (!member) throw new PackageRuleError("This membership has no money in the cohort.");
    const allowed = withdrawable(cohort.status, member.value, member.paidOut);
    if ("refused" in allowed) throw new PackageRuleError(allowed.refused);
    if (amount > allowed.amount) throw new PackageRuleError(`At most ${formatMoney(allowed.amount)} can be withdrawn.`);
    const result = await appendEntry(client, {
      cohortId: cohort.id, membershipId: input.membershipId, kind: "CAPITAL_OUT", amount: -amount,
      sourceType: "withdrawal", sourceId: input.reference, idempotencyKey: input.idempotencyKey,
      note: input.note, actor: input.actor,
    });
    if (result.created) {
      await audit(client, input.actor, "withdrawal.record", input.membershipId, { amount: formatMoney(amount), reference: input.reference });
    }
  });
}

/** One member's own memberships and values. Never anyone else's. */
export async function statementFor(userId: string) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<CohortRow & { package_name: string }>(
      `SELECT c.id, c.package_id, c.starts_at, c.ends_at, c.deposit_cutoff_at, c.status,
              c.opening_capital::text AS opening_capital, c.closing_value::text AS closing_value,
              p.name AS package_name FROM memberships m
         JOIN cohorts c ON c.id = m.cohort_id JOIN packages p ON p.id = c.package_id
        WHERE m.user_id = $1 AND m.status = 'approved' ORDER BY c.starts_at DESC`, [userId]);
    const out = [];
    for (const cohort of rows) {
      const mine = (await valuesOf(client, cohort)).find((v) => v.userId === userId);
      if (!mine) continue;
      out.push({ packageName: cohort.package_name, cohortId: cohort.id, status: cohort.status,
        startsAt: cohort.starts_at.toISOString(), endsAt: cohort.ends_at.toISOString(),
        capitalIn: formatMoney(mine.capitalIn), value: formatMoney(mine.value), paidOut: formatMoney(mine.paidOut) });
    }
    return out;
  } finally {
    client.release();
  }
}
