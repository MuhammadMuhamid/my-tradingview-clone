/**
 * ════════════════════════════════════════════════════════════════════════════
 *  SHARED CROSS-REPOSITORY WEBHOOK CONTRACT — v1
 * ════════════════════════════════════════════════════════════════════════════
 *
 * This file is VENDORED, byte-for-byte, into both repositories:
 *
 *   platform : platform/backend/src/contract/webhookContract.ts
 *   bot      : backend/src/contract/webhookContract.ts
 *
 * Both copies carry `CONTRACT_FINGERPRINT`, and both test suites assert their
 * own file hashes to it. Edit one side and its test fails until the other side
 * and the fingerprint are updated together. That is the whole point: the
 * contract was previously hand-duplicated with no shared artifact and no test,
 * which is the direct cause of X-01, X-02 and X-12.
 *
 * ── Rules for editing ──────────────────────────────────────────────────────
 *
 *  1. NO IMPORTS. This module must stay dependency-free so the two copies can
 *     be byte-identical across a CommonJS project and an ESM one, and so the
 *     platform does not have to take a zod dependency.
 *  2. Bump `CONTRACT_VERSION` on any change that alters what is accepted or
 *     emitted, and record it in the changelog below.
 *  3. Change both copies, and `docs/WEBHOOK-CONTRACT.md`, in ONE commit.
 *  4. Never narrow the accepted set without checking `emittablePayloads()` —
 *     that generator is the definition of "every payload the sender can
 *     produce", and the round-trip test feeds all of them through the
 *     validator.
 *
 * ── Changelog ──────────────────────────────────────────────────────────────
 *
 *  v1  Baseline, plus three corrections to the v0 behaviour the audit found:
 *
 *      * `sell_percent` now accepts exactly 100 (`> 0 && <= 100`). The sender
 *        clamps to 100 whenever `rrTp1Size + rrTp2Size >= 100` — a 50/50 TP
 *        split makes the TP2 leg exactly 100 — and the receiver's `< 100` made
 *        that a terminal 400. The take-profit never reached the exchange while
 *        the platform marked the tier done. Senders SHOULD still express a full
 *        close by omitting `sell_percent`; accepting 100 is the fail-safe.
 *        (X-01)
 *
 *      * The dedupe key is derived from `bar_open_time_ms` only. It used to
 *        embed a bar index, which the two senders compute differently — the
 *        platform as `floor(epoch_ms / interval_ms)` (~1.9e6 for a 15m bar in
 *        2026), Pine as a chart-relative `bar_index` (a few thousand) — so a
 *        comment claiming byte-identity was false and cross-source duplicates
 *        were caught only by a 45-second window. Bar open time is a quantity
 *        both sides agree on. (X-02)
 *
 *      * `ReceiverOutcome` names the three meanings the receiver used to
 *        collapse into one HTTP 200, and `orderPlaced()` /
 *        `mayAdvanceLocalState()` say what each one licences the sender to do.
 *        `ignored_stale_sell` means NO order was placed and the receiver is
 *        still long, so it must not advance local state. (X-12)
 */

/** Bumped on any change to what is accepted or emitted. */
export const CONTRACT_VERSION = 1;

/**
 * SHA-256 of this file's canonical content, computed by
 * `contractFingerprintOf(source)` below. Both repositories assert their own
 * copy against it, so the two cannot drift silently.
 *
 * To update after a deliberate change: run the drift test, take the actual
 * hash it prints, and paste it here in BOTH repositories.
 */
export const CONTRACT_FINGERPRINT =
  "sha256:v1:ed604eaea2cec870ef372b3499061dde9c2901646eff3c5cbb2cab998624c136";

// ── Payload shapes ──────────────────────────────────────────────────────────

export type ContractAction = "buy" | "sell";

/** Exit legs the strategy engines can emit. Stable identities, not free text. */
export const EXIT_LEGS = ["tp1", "tp2", "runner", "stop", "signal"] as const;
export type ExitLeg = (typeof EXIT_LEGS)[number];

/** The custom-bot payload. Field names are the wire format and are frozen. */
export interface CustomBotPayload {
  secret: string;
  action: ContractAction;
  /** Either this or `tv_instrument` must be present. */
  symbol?: string;
  tv_instrument?: string;
  /** BUY only — quote currency to spend. */
  quote_order_qty?: number | null;
  /** Base units. Mutually exclusive with `sell_percent`. */
  quantity?: number | null;
  /** SELL only — percentage of the receiver's tracked position, 0 < x <= 100. */
  sell_percent?: number | null;
  exit_leg?: ExitLeg;
  dedupe_key?: string;
}

/** Bounds, in one place, so both sides cannot disagree about them. */
export const LIMITS = {
  secretMin: 32,
  secretMax: 256,
  actionMax: 40,
  symbolMin: 3,
  symbolMax: 40,
  quoteOrderQtyMax: 1_000_000,
  quantityMax: 1_000_000_000,
  /** Inclusive. Exactly 100 is a full close of the remainder — see X-01. */
  sellPercentMax: 100,
  dedupeKeyMax: 256,
  statusSymbolsMax: 100,
} as const;

/** Every field the strict schema permits. Anything else is rejected. */
export const ALLOWED_FIELDS = [
  "secret",
  "action",
  "symbol",
  "tv_instrument",
  "quote_order_qty",
  "quantity",
  "sell_percent",
  "exit_leg",
  "dedupe_key",
] as const;

// ── Validation ──────────────────────────────────────────────────────────────

export interface ValidationFailure {
  ok: false;
  /** Machine-readable, so a caller can branch without matching prose. */
  code:
    | "not_an_object"
    | "unknown_field"
    | "secret"
    | "action"
    | "symbol"
    | "quote_order_qty"
    | "quantity"
    | "sell_percent"
    | "sell_percent_on_buy"
    | "quantity_and_sell_percent"
    | "exit_leg"
    | "dedupe_key";
  message: string;
}

export interface ValidationSuccess {
  ok: true;
  payload: CustomBotPayload;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

const fail = (code: ValidationFailure["code"], message: string): ValidationFailure =>
  ({ ok: false, code, message });

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** True when the action names an exit rather than an entry. */
export function isExitAction(action: string): boolean {
  const a = action.toLowerCase();
  return a.includes("sell") || a.includes("exit") || a.includes("close");
}

/**
 * The single source of truth for what the receiver accepts.
 *
 * Deliberately hand-written rather than expressed in a validation library, so
 * this file can stay dependency-free and byte-identical in both repositories.
 */
export function validateCustomBotPayload(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("not_an_object", "payload must be a JSON object");
  }
  const body = input as Record<string, unknown>;

  const allowed = new Set<string>(ALLOWED_FIELDS as readonly string[]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return fail("unknown_field", `unexpected field: ${key}`);
  }

  const secret = body.secret;
  if (
    typeof secret !== "string" ||
    secret.length < LIMITS.secretMin ||
    secret.length > LIMITS.secretMax
  ) {
    return fail("secret", `secret must be ${LIMITS.secretMin}-${LIMITS.secretMax} characters`);
  }

  const action = body.action;
  if (typeof action !== "string" || action.length < 1 || action.length > LIMITS.actionMax) {
    return fail("action", `action must be 1-${LIMITS.actionMax} characters`);
  }

  const symbol = body.symbol ?? body.tv_instrument;
  if (typeof symbol !== "string") {
    return fail("symbol", "symbol or tv_instrument required");
  }
  for (const field of ["symbol", "tv_instrument"] as const) {
    const v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length < LIMITS.symbolMin || v.length > LIMITS.symbolMax) {
      return fail("symbol", `${field} must be ${LIMITS.symbolMin}-${LIMITS.symbolMax} characters`);
    }
  }

  const quote = body.quote_order_qty;
  if (quote !== undefined && quote !== null) {
    if (!isFiniteNumber(quote) || quote <= 0 || quote > LIMITS.quoteOrderQtyMax) {
      return fail("quote_order_qty", `quote_order_qty must be > 0 and <= ${LIMITS.quoteOrderQtyMax}`);
    }
  }

  const quantity = body.quantity;
  if (quantity !== undefined && quantity !== null) {
    if (!isFiniteNumber(quantity) || quantity <= 0 || quantity > LIMITS.quantityMax) {
      return fail("quantity", `quantity must be > 0 and <= ${LIMITS.quantityMax}`);
    }
  }

  const sellPercent = body.sell_percent;
  if (sellPercent !== undefined && sellPercent !== null) {
    // `<= 100`, not `< 100`. See the v1 changelog note on X-01.
    if (!isFiniteNumber(sellPercent) || sellPercent <= 0 || sellPercent > LIMITS.sellPercentMax) {
      return fail("sell_percent", `sell_percent must be > 0 and <= ${LIMITS.sellPercentMax}`);
    }
    if (quantity !== undefined && quantity !== null) {
      return fail("quantity_and_sell_percent", "use either sell_percent or quantity, not both");
    }
    if (!isExitAction(action)) {
      return fail("sell_percent_on_buy", "sell_percent is valid only for sell/exit actions");
    }
  }

  const exitLeg = body.exit_leg;
  if (exitLeg !== undefined) {
    if (typeof exitLeg !== "string" || !(EXIT_LEGS as readonly string[]).includes(exitLeg)) {
      return fail("exit_leg", `exit_leg must be one of ${EXIT_LEGS.join(", ")}`);
    }
  }

  const dedupeKey = body.dedupe_key;
  if (dedupeKey !== undefined) {
    if (
      typeof dedupeKey !== "string" ||
      dedupeKey.length < 1 ||
      dedupeKey.length > LIMITS.dedupeKeyMax
    ) {
      return fail("dedupe_key", `dedupe_key must be 1-${LIMITS.dedupeKeyMax} characters`);
    }
  }

  return { ok: true, payload: body as unknown as CustomBotPayload };
}

// ── Dedupe key ──────────────────────────────────────────────────────────────

/**
 * The canonical dedupe key: `<L|X>-<barOpenTimeMs>[-<exitLeg>]`.
 *
 * Derived from bar open time only. The previous form embedded a bar index that
 * the platform and Pine compute differently, so keys from the two senders could
 * never match for the same bar even though a comment asserted they were
 * byte-identical (X-02).
 *
 * Bar open time is the one quantity both sides agree on: Pine's `time` and the
 * platform's `candle.openTime` are the same epoch-millisecond value.
 */
export function dedupeKey(
  action: ContractAction,
  barOpenTimeMs: number,
  exitLeg?: ExitLeg
): string {
  const prefix = action === "buy" ? "L" : "X";
  return `${prefix}-${barOpenTimeMs}${exitLeg ? `-${exitLeg}` : ""}`;
}

/** Parse a canonical key back, or null if it is not one (e.g. a legacy key). */
export function parseDedupeKey(
  key: string
): { action: ContractAction; barOpenTimeMs: number; exitLeg?: ExitLeg } | null {
  const m = /^([LX])-(\d+)(?:-(tp1|tp2|runner|stop|signal))?$/.exec(key);
  if (!m) return null;
  return {
    action: m[1] === "L" ? "buy" : "sell",
    barOpenTimeMs: Number(m[2]),
    ...(m[3] ? { exitLeg: m[3] as ExitLeg } : {}),
  };
}

/**
 * The v0 key form, kept only so the receiver can still recognise a key emitted
 * by a sender that has not been updated yet. Never emit this.
 */
export function legacyDedupeKey(
  action: ContractAction,
  barIndex: number,
  barOpenTimeMs: number,
  exitLeg?: string
): string {
  const prefix = action === "buy" ? "L" : "X";
  return `${prefix}-${barIndex}-${barOpenTimeMs}${exitLeg ? `-${exitLeg}` : ""}`;
}

// ── Receiver outcomes ───────────────────────────────────────────────────────

/**
 * Every outcome the receiver can report. The first three used to share one
 * HTTP 200 and one response shape, and the sender's success test was `res.ok`
 * — so a skipped sell advanced the sender's state while the receiver stayed
 * long (X-12).
 */
export const RECEIVER_OUTCOMES = [
  /** An order was placed at the exchange. */
  "ok",
  /** A duplicate was suppressed. The ORIGINAL order did execute. */
  "ignored_duplicate",
  /**
   * The tracked position was re-opened after a recent close, so the sell was
   * skipped to protect the newer trade. NO order was placed and the receiver
   * is STILL LONG.
   */
  "ignored_stale_sell",
  /** Trading is halted by the operator. No order was placed. */
  "halted",
  /** A risk limit refused the order. No order was placed. */
  "risk_blocked",
] as const;
export type ReceiverOutcome = (typeof RECEIVER_OUTCOMES)[number];

export const isReceiverOutcome = (v: unknown): v is ReceiverOutcome =>
  typeof v === "string" && (RECEIVER_OUTCOMES as readonly string[]).includes(v);

/** Did an order actually reach the exchange as a result of THIS request? */
export function orderPlaced(outcome: ReceiverOutcome): boolean {
  return outcome === "ok";
}

/**
 * May the sender advance its local position state on this outcome?
 *
 * `ignored_duplicate` yes: a duplicate implies the original order landed, so
 * the receiver's state already matches what the sender intends.
 *
 * `ignored_stale_sell`, `halted`, `risk_blocked` NO: the receiver holds a
 * position the sender wanted closed. Advancing to flat here is exactly how the
 * platform ends up issuing a fresh BUY into a position it does not know it
 * holds.
 */
export function mayAdvanceLocalState(outcome: ReceiverOutcome): boolean {
  return outcome === "ok" || outcome === "ignored_duplicate";
}

/**
 * The HTTP status the receiver SHOULD return for each outcome.
 *
 * `ignored_stale_sell` and the two refusals are 409, not 200, so a sender that
 * ignores the response body still fails safe. `ignored_duplicate` stays 200
 * because it is genuinely a success from the sender's point of view.
 */
export function httpStatusFor(outcome: ReceiverOutcome): number {
  switch (outcome) {
    case "ok":
    case "ignored_duplicate":
      return 200;
    case "ignored_stale_sell":
    case "halted":
    case "risk_blocked":
      return 409;
  }
}

// ── Emittable payload set ───────────────────────────────────────────────────

/**
 * Every shape the sender can legitimately produce.
 *
 * The round-trip contract test in BOTH repositories feeds this whole set
 * through `validateCustomBotPayload` and asserts each one is accepted. A
 * boundary the sender can reach and the receiver rejects — which is exactly
 * what X-01 was — therefore fails the build on both sides.
 */
export function emittablePayloads(secret: string): CustomBotPayload[] {
  const out: CustomBotPayload[] = [];
  const symbol = "APTUSDT";
  const barTime = 1_700_000_000_000;

  // Entries, across the order-size range the deployment schema permits.
  for (const quote of [1, 70.01, 320.01, 340.01, 800, LIMITS.quoteOrderQtyMax]) {
    out.push({
      secret,
      action: "buy",
      symbol,
      quote_order_qty: quote,
      dedupe_key: dedupeKey("buy", barTime),
    });
  }

  // Full close: no sell_percent at all.
  out.push({ secret, action: "sell", symbol, dedupe_key: dedupeKey("sell", barTime) });

  // Partial exits, every leg against every reachable percentage — including
  // exactly 100, which the clamp in the evaluator can produce.
  for (const leg of EXIT_LEGS) {
    for (const pct of [0.01, 1, 25, 30, 40, 50, 60, 66.6667, 99.99, 100]) {
      out.push({
        secret,
        action: "sell",
        symbol,
        sell_percent: pct,
        exit_leg: leg,
        dedupe_key: dedupeKey("sell", barTime, leg),
      });
    }
  }

  // `tv_instrument` instead of `symbol`, as TradingView sends it.
  out.push({
    secret,
    action: "buy",
    tv_instrument: "BINANCE:APTUSDT",
    quote_order_qty: 100,
    dedupe_key: dedupeKey("buy", barTime),
  });

  // An explicit base quantity rather than a percentage.
  out.push({
    secret,
    action: "sell",
    symbol,
    quantity: 1.23456789,
    dedupe_key: dedupeKey("sell", barTime),
  });

  return out;
}

// ── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Canonicalise this file's source for hashing: line endings normalised,
 * trailing whitespace stripped, and the fingerprint constant itself blanked
 * (it cannot contain its own hash).
 *
 * Kept here rather than in the test so both repositories canonicalise the same
 * way — a difference in that step would produce a spurious drift failure.
 */
export function canonicalizeContractSource(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(
      /export const CONTRACT_FINGERPRINT =[\s\S]*?;/,
      "export const CONTRACT_FINGERPRINT = <ELIDED>;"
    )
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}
