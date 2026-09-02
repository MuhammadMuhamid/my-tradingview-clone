/**
 * ════════════════════════════════════════════════════════════════════════════
 *  SHARED CROSS-REPOSITORY WEBHOOK CONTRACT — v2
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
 *  v4  Makes the Shariah block USABLE on the direct-webhook path, which v3
 *      left open.
 *
 *      v3 made the block optional so an un-updated sender kept working, and
 *      relied on a receiver-side "enforcement latch" to stop omission becoming
 *      a downgrade. Two things were wrong with that on the webhook path:
 *
 *        * nothing could arm the latch for a webhook sender. The latch is
 *          keyed per sender scope, and the only senders that could present a
 *          block were on a DIFFERENT scope, so a receiver whose operator had
 *          turned enforcement on still admitted every direct webhook BUY
 *          ungated. That was a real bypass, not a transitional gap.
 *        * the webhook body is authenticated only by the per-bot shared secret
 *          it carries. A block inside it could therefore lower the latch back
 *          to `off`, and a signal source could assert its own compliance.
 *
 *      v4 separates the two concerns that v3 conflated:
 *
 *        POLICY  — whether a scope enforces at all — is set only over the
 *                  sender's HMAC control channel, never by a webhook body.
 *        EVIDENCE — the per-asset decision for one order — may ride in the
 *                  webhook body, but under `enforce` it must carry a detached
 *                  sender signature (`shariah_sig` over the canonical string
 *                  built by `shariahEvidenceCanonical`, plus `shariah_ts`).
 *
 *      A direct TradingView alert can produce neither, which is the point: it
 *      is not a screening authority. Under enforcement it is refused with
 *      `SHARIAH_CONTEXT_REQUIRED`; with enforcement off it behaves exactly as
 *      it always has.
 *
 *      SELL is untouched. An exit carries no signature requirement and is never
 *      refused, whatever the block says or fails to say.
 *
 *  v3  Adds the optional `shariah` execution-context block and the
 *      `shariah_blocked` receiver outcome.
 *
 *      The Platform is the ONLY authority for Shariah screening: it resolves an
 *      asset against its own registry and transmits the resulting DECISION.
 *      This receiver holds no registry, performs no screening, and reacts only
 *      to authenticated execution intents. Its single job is the final exposure
 *      rule — refuse to CREATE new Spot exposure unless the authenticated
 *      decision says ELIGIBLE for the base asset of the symbol actually traded.
 *
 *      The block is OPTIONAL, so a sender that has not been updated (including
 *      a direct TradingView alert, which cannot produce one) keeps exactly its
 *      current non-Shariah behaviour. Omission is NOT a downgrade path once a
 *      scope has been told `mode: "enforce"` — see the receiver's enforcement
 *      latch, which is receiver state, not contract state.
 *
 *      SELL is deliberately absent from every rule below. Shariah
 *      classification may never prevent reducing or exiting exposure, and the
 *      receiver never creates a SELL because a classification changed.
 *
 *  v2  Adds optional paired Platform deployment/order-intent correlation.
 *      Platform emits it as HTTP headers, which an old Bot safely ignores;
 *      the legacy JSON body remains unchanged. Direct TradingView payloads
 *      remain valid.
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
export const CONTRACT_VERSION = 4;

/**
 * SHA-256 of this file's canonical content, computed by
 * `contractFingerprintOf(source)` below. Both repositories assert their own
 * copy against it, so the two cannot drift silently.
 *
 * To update after a deliberate change: run the drift test, take the actual
 * hash it prints, and paste it here in BOTH repositories.
 */
export const CONTRACT_FINGERPRINT =
  "sha256:v4:8f57c21b5d3e381fb1902d38a5f502179afbbb1ce52181e82c8e22bb53a356b7";

// ── Payload shapes ──────────────────────────────────────────────────────────

export type ContractAction = "buy" | "sell";

/** Optional HTTP metadata; deliberately outside the strict legacy JSON body. */
export const PLATFORM_DEPLOYMENT_ID_HEADER = "x-platform-deployment-id";
export const PLATFORM_ORDER_INTENT_ID_HEADER = "x-platform-order-intent-id";

/** Exit legs the strategy engines can emit. Stable identities, not free text. */
export const EXIT_LEGS = ["tp1", "tp2", "runner", "stop", "signal"] as const;
export type ExitLeg = (typeof EXIT_LEGS)[number];

// ── Shariah execution context ───────────────────────────────────────────────

/**
 * `off`   — the sender is not enforcing; the receiver behaves exactly as it did
 *           before this block existed.
 * `enforce` — the sender asserts a screening decision the receiver must apply
 *           to new Spot exposure.
 */
export type ShariahMode = "off" | "enforce";

/** The only policy identity this contract version accepts under `enforce`. */
export const SHARIAH_POLICY_VERSION = "TS_SHARIAH_V1";

/**
 * The three statuses that can cross the wire. The sender resolves its internal
 * UNSCREENED and STALE states to REVIEW before transmission, so the receiver
 * never has to know they exist — and never has to decide what they mean.
 */
export const SHARIAH_STATUSES = ["ELIGIBLE", "REVIEW", "EXCLUDED"] as const;
export type ShariahStatus = (typeof SHARIAH_STATUSES)[number];

/**
 * The signed decision block.
 *
 * `assetId`       the sender's authoritative registry identity.
 * `baseAsset`     base asset of the exact Spot symbol being traded. This is the
 *                 field that binds a decision to a symbol, so an ELIGIBLE proof
 *                 for one asset cannot authorise a BUY of another.
 * `publicationId` the current publication identity where one exists. It may be
 *                 null ONLY for a genuinely unresolved REVIEW.
 */
export interface ShariahContext {
  mode: ShariahMode;
  policyVersion?: string | null;
  assetId?: string | null;
  baseAsset?: string | null;
  effectiveStatus?: ShariahStatus | null;
  publicationId?: string | null;
}

/** Every field the block permits. Anything else is rejected. */
export const SHARIAH_FIELDS = [
  "mode",
  "policyVersion",
  "assetId",
  "baseAsset",
  "effectiveStatus",
  "publicationId",
] as const;

/** Bounds, in one place, so neither side can disagree about them. */
export const SHARIAH_LIMITS = {
  identityMax: 128,
  baseAssetMin: 2,
  baseAssetMax: 20,
} as const;

const SHARIAH_IDENTITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHARIAH_BASE_ASSET_RE = /^[A-Z0-9]{2,20}$/;

/**
 * Bounded reason codes, so an operator can tell a Shariah refusal apart from an
 * authentication failure, a risk refusal, or an exchange failure — and can tell
 * the five Shariah refusals apart from each other.
 */
export const SHARIAH_REJECTION_CODES = [
  /** The block is structurally unusable: bad shape, bad status, bad identity. */
  "SHARIAH_CONTEXT_INVALID",
  /** `enforce` was requested against a policy identity this build cannot apply. */
  "SHARIAH_POLICY_MISMATCH",
  /** The decision names a different base asset than the symbol being traded. */
  "SHARIAH_ASSET_MISMATCH",
  /** Screening is unresolved. New exposure is refused; exits stay open. */
  "SHARIAH_REVIEW_BLOCKED",
  /** Screening excluded the asset. New exposure is refused; exits stay open. */
  "SHARIAH_EXCLUDED_BLOCKED",
  /** No block at all, from a sender scope already latched to `enforce`. */
  "SHARIAH_CONTEXT_REQUIRED",
  /**
   * A block arrived on a path that cannot authenticate it — a webhook body
   * carrying no detached signature, one that does not verify, or one that has
   * expired. Distinct from CONTEXT_REQUIRED so an operator can tell "the sender
   * sent nothing" apart from "something sent a decision it could not prove".
   */
  "SHARIAH_EVIDENCE_UNVERIFIED",
] as const;
export type ShariahRejectionCode = (typeof SHARIAH_REJECTION_CODES)[number];

export type ShariahContextResult =
  | { ok: true; context: ShariahContext }
  | { ok: false; code: ShariahRejectionCode; message: string };

const shariahFail = (
  code: ShariahRejectionCode,
  message: string
): ShariahContextResult => ({ ok: false, code, message });

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an own property only.
 *
 * `JSON.parse` materialises a literal `"__proto__"` key as an OWN property, so
 * a caller-supplied object can carry keys that plain member access would
 * resolve against the prototype chain instead. Every read here goes through
 * this, and the unknown-key sweep below rejects `__proto__` outright anyway.
 */
function ownField(body: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, key) ? body[key] : undefined;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * The single source of truth for what a Shariah block may contain.
 *
 * Deliberately strict and bounded: no nested objects, no arrays, no free text,
 * no unknown keys. This validates SHAPE and internal consistency only. Whether
 * a valid block permits a given order is the receiver's decision, because only
 * the receiver knows the symbol actually being sent to the exchange.
 */
export function validateShariahContext(input: unknown): ShariahContextResult {
  if (!isPlainRecord(input)) {
    return shariahFail("SHARIAH_CONTEXT_INVALID", "shariah must be a JSON object");
  }

  const allowed = new Set<string>(SHARIAH_FIELDS as readonly string[]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      return shariahFail("SHARIAH_CONTEXT_INVALID", `unexpected shariah field: ${key}`);
    }
  }

  const mode = ownField(input, "mode");
  if (mode !== "off" && mode !== "enforce") {
    return shariahFail("SHARIAH_CONTEXT_INVALID", 'shariah.mode must be "off" or "enforce"');
  }

  const policyVersion = ownField(input, "policyVersion");
  const assetId = ownField(input, "assetId");
  const baseAsset = ownField(input, "baseAsset");
  const effectiveStatus = ownField(input, "effectiveStatus");
  const publicationId = ownField(input, "publicationId");

  for (const [name, value] of [
    ["policyVersion", policyVersion],
    ["assetId", assetId],
    ["baseAsset", baseAsset],
    ["effectiveStatus", effectiveStatus],
    ["publicationId", publicationId],
  ] as const) {
    if (!absent(value) && typeof value !== "string") {
      return shariahFail("SHARIAH_CONTEXT_INVALID", `shariah.${name} must be a string or null`);
    }
  }

  if (mode === "off") {
    /*
     * An explicit `off` carries no decision to check. It is still meaningful:
     * it is the sender stating, under the same authentication as an order, that
     * enforcement is not active for this scope.
     */
    return { ok: true, context: { mode } };
  }

  if (policyVersion !== SHARIAH_POLICY_VERSION) {
    return shariahFail(
      "SHARIAH_POLICY_MISMATCH",
      `shariah.policyVersion must be ${SHARIAH_POLICY_VERSION} to enforce`
    );
  }
  if (typeof effectiveStatus !== "string" ||
      !(SHARIAH_STATUSES as readonly string[]).includes(effectiveStatus)) {
    return shariahFail(
      "SHARIAH_CONTEXT_INVALID",
      `shariah.effectiveStatus must be one of ${SHARIAH_STATUSES.join(", ")}`
    );
  }
  if (typeof assetId !== "string" || !SHARIAH_IDENTITY_RE.test(assetId)) {
    return shariahFail("SHARIAH_CONTEXT_INVALID", "shariah.assetId is not a valid registry identity");
  }
  if (typeof baseAsset !== "string" || !SHARIAH_BASE_ASSET_RE.test(baseAsset)) {
    return shariahFail("SHARIAH_CONTEXT_INVALID", "shariah.baseAsset is not a valid base asset");
  }
  if (!absent(publicationId) &&
      (typeof publicationId !== "string" || !SHARIAH_IDENTITY_RE.test(publicationId))) {
    return shariahFail(
      "SHARIAH_CONTEXT_INVALID",
      "shariah.publicationId is not a valid publication identity"
    );
  }
  /*
   * A missing publication is legitimate only while screening is genuinely
   * unresolved. An ELIGIBLE with no publication behind it is not a decision the
   * sender could have published, so it fails closed rather than authorising an
   * entry.
   */
  if (absent(publicationId) && effectiveStatus !== "REVIEW") {
    return shariahFail(
      "SHARIAH_CONTEXT_INVALID",
      "shariah.publicationId may be null only for an unresolved REVIEW"
    );
  }

  return {
    ok: true,
    context: {
      mode,
      policyVersion,
      assetId,
      baseAsset,
      effectiveStatus: effectiveStatus as ShariahStatus,
      publicationId: absent(publicationId) ? null : (publicationId as string),
    },
  };
}

/**
 * The fixed V1 rule for CREATING new Spot exposure. ELIGIBLE and nothing else.
 *
 * There is no SELL counterpart on purpose: an exit is never gated here.
 */
export function shariahStatusPermitsEntry(status: ShariahStatus): status is "ELIGIBLE" {
  return status === "ELIGIBLE";
}

/** The refusal code a non-entry-permitting status maps to. */
export function shariahBlockCodeFor(
  status: Exclude<ShariahStatus, "ELIGIBLE">
): Extract<ShariahRejectionCode, "SHARIAH_REVIEW_BLOCKED" | "SHARIAH_EXCLUDED_BLOCKED"> {
  return status === "REVIEW" ? "SHARIAH_REVIEW_BLOCKED" : "SHARIAH_EXCLUDED_BLOCKED";
}

// ── Detached evidence signature (webhook path only) ─────────────────────────

/**
 * How long a signed decision stays usable, in milliseconds.
 *
 * Long enough to cover the sender's delivery retries with backoff, short enough
 * that a captured ELIGIBLE cannot be replayed weeks later against an asset that
 * has since been excluded. The receiver's own duplicate suppression is what
 * stops replay INSIDE the window.
 */
export const SHARIAH_EVIDENCE_MAX_AGE_MS = 10 * 60 * 1000;

/** Wire field carrying the detached signature, and the time it was produced. */
export const SHARIAH_SIGNATURE_FIELD = "shariah_sig";
export const SHARIAH_TIMESTAMP_FIELD = "shariah_ts";

/** `v1=` plus 64 lowercase hex characters. */
const SHARIAH_SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;
/** Milliseconds since the epoch, as digits. */
const SHARIAH_TIMESTAMP_RE = /^[0-9]{10,17}$/;

export function isShariahSignatureShaped(value: unknown): value is string {
  return typeof value === "string" && SHARIAH_SIGNATURE_RE.test(value);
}

export function isShariahTimestampShaped(value: unknown): value is string {
  return typeof value === "string" && SHARIAH_TIMESTAMP_RE.test(value);
}

/**
 * Canonical bytes both sides sign and verify. Defined here so the sender and
 * the receiver cannot disagree about them.
 *
 * It binds the decision to the exact SYMBOL and SIDE of the order carrying it,
 * so a signature captured from an ELIGIBLE BUY of one asset cannot be lifted
 * onto a BUY of another, and to a TIMESTAMP, so it expires. The block itself is
 * serialised field-by-field in the fixed `SHARIAH_FIELDS` order rather than
 * with `JSON.stringify`, so key order in the transmitted JSON cannot change
 * what was signed.
 */
export function shariahEvidenceCanonical(input: {
  symbol: string;
  side: ContractAction;
  timestamp: string;
  context: ShariahContext;
}): string {
  const context = input.context as unknown as Record<string, unknown>;
  const fields = SHARIAH_FIELDS.map((field) => {
    const value = context[field];
    return `${field}=${value === undefined || value === null ? "" : String(value)}`;
  });
  return [
    "TS_SHARIAH_EVIDENCE_V1",
    input.symbol.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    input.side,
    input.timestamp,
    ...fields,
  ].join("\n");
}

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
  /**
   * Optional. Absent means "this sender is not enforcing", which keeps the
   * receiver's pre-Shariah behaviour exactly. Present and `enforce` means the
   * receiver must apply the decision to a BUY.
   */
  shariah?: ShariahContext;
  /**
   * Detached sender signature over `shariahEvidenceCanonical`, and the
   * timestamp it covers. Required alongside an `enforce` block on this path,
   * because the body itself is authenticated only by the shared secret it
   * carries — see the v4 changelog entry.
   */
  shariah_sig?: string;
  shariah_ts?: string;
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
  "shariah",
  SHARIAH_SIGNATURE_FIELD,
  SHARIAH_TIMESTAMP_FIELD,
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
    | "dedupe_key"
    | "shariah"
    | "shariah_signature";
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

  const shariah = body.shariah;
  if (shariah !== undefined) {
    const checked = validateShariahContext(shariah);
    if (!checked.ok) return fail("shariah", `${checked.code}: ${checked.message}`);
  }

  /*
   * Shape only. Whether a signature is REQUIRED, and whether it verifies, is
   * the receiver's decision: only the receiver holds the shared secret, and
   * only the receiver knows whether the scope is enforcing. Rejecting a
   * malformed one here would also let it 400 a SELL, which must never happen.
   */
  const shariahSig = body[SHARIAH_SIGNATURE_FIELD];
  if (shariahSig !== undefined && !isShariahSignatureShaped(shariahSig)) {
    return fail("shariah_signature", `${SHARIAH_SIGNATURE_FIELD} must be "v1=" plus 64 hex characters`);
  }
  const shariahTs = body[SHARIAH_TIMESTAMP_FIELD];
  if (shariahTs !== undefined && !isShariahTimestampShaped(shariahTs)) {
    return fail("shariah_signature", `${SHARIAH_TIMESTAMP_FIELD} must be epoch milliseconds`);
  }
  if ((shariahSig === undefined) !== (shariahTs === undefined)) {
    return fail("shariah_signature",
      `${SHARIAH_SIGNATURE_FIELD} and ${SHARIAH_TIMESTAMP_FIELD} are emitted together or not at all`);
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
  /**
   * The authenticated Shariah decision does not permit CREATING new exposure.
   * No order was placed and the receiver's position is unchanged. Only a BUY
   * can produce this: an exit is never refused on Shariah grounds.
   */
  "shariah_blocked",
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
 *
 * `shariah_blocked` NO: no entry was made, so the sender is still flat and must
 * not record a position it does not have.
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
    case "shariah_blocked":
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

  // Every Shariah block the sender can legitimately produce.
  //
  // Entries appear for all three statuses because the sender emits the DECISION
  // it holds; refusing REVIEW and EXCLUDED is the receiver's job, and a payload
  // the receiver refuses on policy grounds must still be a VALID payload. Exits
  // appear for all three because an exit is never gated on the status.
  const shariahBlocks: ShariahContext[] = [
    { mode: "off" },
    ...SHARIAH_STATUSES.map((effectiveStatus) => ({
      mode: "enforce" as const,
      policyVersion: SHARIAH_POLICY_VERSION,
      assetId: "reg_apt_0001",
      baseAsset: "APT",
      effectiveStatus,
      publicationId: "pub_2026_09_02",
    })),
    // The one legitimate null publication: an unresolved REVIEW.
    {
      mode: "enforce",
      policyVersion: SHARIAH_POLICY_VERSION,
      assetId: "reg_apt_0001",
      baseAsset: "APT",
      effectiveStatus: "REVIEW",
      publicationId: null,
    },
  ];
  for (const shariah of shariahBlocks) {
    // Both shapes the sender emits: bare (the manual HMAC channel, where the
    // request signature already covers the block) and detached-signed (the
    // webhook path, where it does not).
    const signed = {
      [SHARIAH_SIGNATURE_FIELD]: `v1=${"0".repeat(64)}`,
      [SHARIAH_TIMESTAMP_FIELD]: String(barTime),
    };
    for (const extra of [{}, signed]) {
      out.push({
        secret, action: "buy", symbol, quote_order_qty: 100,
        dedupe_key: dedupeKey("buy", barTime), shariah, ...extra,
      });
      out.push({
        secret, action: "sell", symbol,
        dedupe_key: dedupeKey("sell", barTime), shariah, ...extra,
      });
    }
  }

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
