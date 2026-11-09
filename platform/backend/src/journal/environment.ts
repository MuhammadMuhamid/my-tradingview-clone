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

/** A Bot-owned ManualPosition (a manual SmartTrade) as the state read lists it. */
export interface ManualPositionEnvironmentEvidence {
  exchangeAccountId: string | null | undefined;
  /** The entry's exchange order id, when the Bot sends it. */
  exchangeOrderId?: string | null;
  clientOrderId?: string | null;
  /** The entry ManualOrder's id, when the Bot sends it. */
  manualOrderId?: string | null;
}

/**
 * A manual position, by the same rule as its entry order, so the chart's
 * position line can never say TESTNET where the order's own marker, the strip,
 * the ticket and the Journal say DRY RUN (walkthrough D-4).
 *
 * 1. The position's own exchange/client id, or its entry order's exchange id
 *    (found by `manualOrderId` in the same state read), is `dry-` → DRY_RUN.
 * 2. Otherwise the order rule on the position's account with that exchange id:
 *    TESTNET on a testnet account; REAL only on an explicit mainnet account
 *    with a non-simulated exchange id; otherwise UNKNOWN.
 *
 * Today's Bot lists positions WITHOUT any of those ids, so a position is still
 * decided by its account alone: TESTNET on a testnet account (true — not real
 * funds — but not as precise as DRY_RUN), UNKNOWN otherwise, never REAL. The
 * Bot must add `manualOrderId`/`exchangeOrderId` to its position read for
 * rule 1 to apply; nothing here guesses the entry from prices or times.
 */
export function manualPositionEnvironment(
  position: ManualPositionEnvironmentEvidence,
  accounts: readonly ManualAccountEnvironmentEvidence[] | null | undefined,
  orders: readonly { id: string; exchangeOrderId?: string | null }[] = [],
): ExecutionEnvironment {
  const entryId = text(position.manualOrderId);
  const entry = entryId === null ? undefined : orders.find((order) => order.id === entryId);
  if (isDryRunExchangeOrderId(position.exchangeOrderId) || isDryRunExchangeOrderId(position.clientOrderId)
      || isDryRunExchangeOrderId(entry?.exchangeOrderId)) return "DRY_RUN";
  return manualOrderEnvironment({
    exchangeOrderId: text(position.exchangeOrderId) ?? entry?.exchangeOrderId ?? null,
    exchangeAccountId: position.exchangeAccountId, accounts,
  });
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
 * 3. A declaration that contradicts the row's own exchange id (OD-5
 *    consistency rule): MAINNET with a `dry-` id, or DRY_RUN with an id that is
 *    not `dry-` → UNKNOWN. Neither side is believed over the other, and
 *    UNKNOWN is never real money.
 * 4. A `dry-` exchange order id → DRY_RUN.
 * 5. An explicit, valid declared environment → that value (MAINNET → REAL).
 * 6. Otherwise → UNKNOWN.
 */
export function automatedEnvironment(input: {
  delivery: string | null | undefined;
  exchangeOrderId?: string | null;
  declaredEnvironment?: unknown;
}): ExecutionEnvironment {
  if (input.delivery === "paper") return "PAPER";
  if (input.delivery !== "custom") return "UNKNOWN";
  const declared = declaredRealizationEnvironment(input.declaredEnvironment);
  const dry = isDryRunExchangeOrderId(input.exchangeOrderId);
  if ((declared === "REAL" && dry) || (declared === "DRY_RUN" && !dry)) return "UNKNOWN";
  if (dry) return "DRY_RUN";
  return declared ?? "UNKNOWN";
}

/**
 * A persisted realization. Only a `BOT_CUSTOM_V1` row is proven to come from
 * the custom Bot: the ingest refuses any event whose deployment was not
 * `custom` at receipt. A legacy row (no source system) proves nothing, and the
 * deployment's current delivery is deliberately not consulted — a deployment
 * switched from custom to paper must not relabel its Bot history PAPER.
 *
 * A contract v2 event declares its environment (`declared_environment`,
 * OD-5); a v1 event, an UNKNOWN declaration and a contradicted one stay
 * UNKNOWN. The P&L stays the Bot's modeled figure either way.
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
