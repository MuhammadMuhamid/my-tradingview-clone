/**
 * Which money an execution record is about. One module, used by the Journal
 * projection, the chart overlays and the manual Timeline, so the same order
 * cannot be REAL on one surface and DRY_RUN on another (defect D3).
 *
 * The rules are deliberately one-directional:
 *
 * - REAL is returned only on POSITIVE PER-ROW evidence. There is no
 *   `default: "REAL"` anywhere in this file, and none may be added.
 * - The Bot's CURRENT mode, its current dry-run flag, and a deployment's
 *   CURRENT delivery setting are never used to label a historical row. A Bot
 *   that is on mainnet today says nothing about an order from last week, and a
 *   Bot in dry-run today does not turn an acknowledged mainnet order into a
 *   simulation.
 * - Anything unproven is UNKNOWN, and UNKNOWN is never counted as real money.
 *
 * This module imports nothing, so every surface can depend on it without an
 * import cycle.
 */
export type ExecutionEnvironment = "REAL" | "TESTNET" | "DRY_RUN" | "PAPER" | "UNKNOWN";

export const EXECUTION_ENVIRONMENTS: readonly ExecutionEnvironment[] =
  ["REAL", "TESTNET", "DRY_RUN", "PAPER", "UNKNOWN"];

/**
 * The Bot answers every simulated submission or cancel with an exchange order
 * id carrying this prefix (Bot `services/binance.ts` market BUY/SELL and
 * `services/manualExchange.ts` LIMIT/cancel), and persists it on the row. It is
 * the one durable, per-row trace of a dry run.
 */
export const DRY_RUN_EXCHANGE_ORDER_ID_PREFIX = "dry-";

/** `source_system` written by the authenticated Bot realization ingest. */
export const BOT_REALIZATION_SOURCE_SYSTEM = "BOT_CUSTOM_V1";

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export function isDryRunExchangeOrderId(exchangeOrderId: unknown): boolean {
  return text(exchangeOrderId)?.startsWith(DRY_RUN_EXCHANGE_ORDER_ID_PREFIX) ?? false;
}

/** A non-simulated exchange acknowledgement: present, non-blank, not `dry-`. */
function exchangeAcknowledged(exchangeOrderId: unknown): boolean {
  return text(exchangeOrderId) !== null && !isDryRunExchangeOrderId(exchangeOrderId);
}

/** One Bot exchange account as `/api/manual-trading/state` lists it. */
export interface ManualAccountEnvironmentEvidence {
  id: string;
  testnet?: unknown;
  mode?: unknown;
}

function findAccount(
  accountId: unknown, accounts: readonly ManualAccountEnvironmentEvidence[] | null | undefined
): ManualAccountEnvironmentEvidence | undefined {
  const id = text(accountId);
  if (id === null || !Array.isArray(accounts)) return undefined;
  return accounts.find((candidate) => candidate !== null && typeof candidate === "object"
    && candidate.id === id);
}

/**
 * A manual order's environment, from the order's own durable facts only.
 *
 * 1. A `dry-` exchange order id → DRY_RUN.
 * 2. The order's own account (`exchangeAccountId`; a Bot account's testnet flag
 *    cannot be edited, and an account with orders cannot be deleted):
 *    `testnet === true` → TESTNET.
 * 3. `testnet === false` (an explicit boolean, not contradicted by the
 *    account's `mode`) AND a non-`dry-` exchange order id → REAL.
 * 4. Everything else → UNKNOWN: no account, an account the Bot no longer
 *    lists, a missing or non-boolean flag, or a mainnet account with no
 *    exchange acknowledgement.
 *
 * The Bot's current `dryRun` flag is not an input. The one case where it is
 * the only signal — an order that never received an exchange id (a dry-run
 * submit that failed before its snapshot, or one still pending) — is UNKNOWN
 * on a mainnet account: today's flag cannot prove what held when the order was
 * placed. On a testnet account it is still TESTNET, by rule 2.
 */
export function manualOrderEnvironment(input: {
  exchangeOrderId: string | null | undefined;
  exchangeAccountId: string | null | undefined;
  accounts: readonly ManualAccountEnvironmentEvidence[] | null | undefined;
}): ExecutionEnvironment {
  if (isDryRunExchangeOrderId(input.exchangeOrderId)) return "DRY_RUN";
  const account = findAccount(input.exchangeAccountId, input.accounts);
  if (account?.testnet === true) return "TESTNET";
  if (account?.testnet === false && account.mode !== "testnet"
      && exchangeAcknowledged(input.exchangeOrderId)) return "REAL";
  return "UNKNOWN";
}

/**
 * A Bot-owned ManualPosition carries an account but no exchange order id of
 * its own, and in dry-run it is built from simulated fills. So it is TESTNET on
 * a testnet account and otherwise UNKNOWN — never REAL.
 */
export function manualPositionEnvironment(
  exchangeAccountId: string | null | undefined,
  accounts: readonly ManualAccountEnvironmentEvidence[] | null | undefined
): ExecutionEnvironment {
  return manualOrderEnvironment({ exchangeOrderId: null, exchangeAccountId, accounts });
}

/**
 * The values a future Bot realization payload may declare. Strict: anything
 * else — `"REAL"`, lower case, a number, an object — is not evidence.
 */
const DECLARED_ENVIRONMENTS: Readonly<Record<string, ExecutionEnvironment>> = {
  DRY_RUN: "DRY_RUN",
  TESTNET: "TESTNET",
  MAINNET: "REAL",
};

export function declaredRealizationEnvironment(value: unknown): ExecutionEnvironment | null {
  return typeof value === "string" && Object.hasOwn(DECLARED_ENVIRONMENTS, value)
    ? DECLARED_ENVIRONMENTS[value]! : null;
}

/**
 * An automated row's environment.
 *
 * `delivery` must be the delivery PROVEN FOR THIS ROW — see the two callers
 * below — not merely the deployment's current setting, which an operator can
 * change at any time (`PATCH /api/deployments/:id`).
 *
 * 1. `paper` → PAPER.
 * 2. Not proven to be the custom Bot (`3commas`, `off`, unknown) → UNKNOWN.
 * 3. A `dry-` exchange order id → DRY_RUN.
 * 4. An explicit, valid declared environment → that value (MAINNET → REAL).
 * 5. Otherwise → UNKNOWN.
 */
export function automatedEnvironment(input: {
  delivery: string | null | undefined;
  exchangeOrderId?: string | null;
  declaredEnvironment?: unknown;
}): ExecutionEnvironment {
  if (input.delivery === "paper") return "PAPER";
  if (input.delivery !== "custom") return "UNKNOWN";
  if (isDryRunExchangeOrderId(input.exchangeOrderId)) return "DRY_RUN";
  return declaredRealizationEnvironment(input.declaredEnvironment) ?? "UNKNOWN";
}

/**
 * A persisted realization. Only a `BOT_CUSTOM_V1` row is proven to come from
 * the custom Bot: the ingest refuses any event whose deployment was not
 * `custom` at receipt. A legacy row (no source system) proves nothing, and the
 * deployment's current delivery is deliberately not consulted — a deployment
 * switched from custom to paper must not relabel its Bot history PAPER.
 *
 * Simulated closes never emit a realization event, so in practice a Bot row is
 * TESTNET or REAL — and nothing stored today says which. Until the event
 * carries an environment (see `declaredEnvironment`), such a row is UNKNOWN.
 */
export function automatedRealizationEnvironment(row: {
  sourceSystem?: string | null;
  exchangeOrderId?: string | null;
  declaredEnvironment?: unknown;
}): ExecutionEnvironment {
  return automatedEnvironment({
    delivery: row.sourceSystem === BOT_REALIZATION_SOURCE_SYSTEM ? "custom" : null,
    exchangeOrderId: row.exchangeOrderId, declaredEnvironment: row.declaredEnvironment,
  });
}

/**
 * Persisted automated activity (order intents, execution snapshots). These
 * rows record no delivery of their own, so the deployment's current delivery
 * is the only one available. It is used ONLY in the directions that cannot
 * produce REAL: `3commas`/`off`/missing → UNKNOWN, and `custom` merely lets the
 * row's own `dry-` id read as DRY_RUN. An activity row is never REAL.
 */
export function automatedActivityEnvironment(row: {
  delivery?: string | null;
  exchangeOrderId?: string | null;
}): ExecutionEnvironment {
  return automatedEnvironment({ delivery: row.delivery ?? null, exchangeOrderId: row.exchangeOrderId });
}
