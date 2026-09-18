/**
 * The ONE backend authority that decides whether a Spot intent may create new
 * exposure, and the ONE place the signed Platform->Bot `shariah` context block
 * is built.
 *
 * Every Platform path capable of producing a Spot BUY calls
 * `assertShariahExposureAllowed` (manual order route, LiveRunner's single
 * emission chokepoint, the live test-signal route). Frontend disabling is UX;
 * this is the enforcement.
 *
 * The semantics, stated once so no caller can hold a different opinion:
 *
 * - SPOT ONLY. BUY creates or increases exposure and is gated. SELL reduces or
 *   exits exposure and is NEVER gated — not by classification, not by mode, not
 *   by an unresolvable asset. An operator holding a position that has just been
 *   re-screened EXCLUDED must always be able to get out of it.
 * - NOTHING HERE LIQUIDATES. The gate returns allow/deny for an intent the
 *   caller already had. It never generates an order, never closes a position,
 *   and a status change is therefore never able to sell anything: the only
 *   effect of an asset going EXCLUDED is that the next BUY is refused.
 * - FAIL CLOSED ON IDENTITY. A symbol with no resolvable registry identity
 *   (non-USDT quote, unknown base asset, asset absent from the registry) is
 *   `REVIEW`, not "unclassified, therefore fine". UNSCREENED and STALE have
 *   already collapsed to REVIEW in policy.ts `effectiveShariahStatus`; this
 *   module never re-derives that mapping.
 * - NO CACHE. Mode and classification are read per intent (mode.ts explains
 *   why), so an asset re-screened a second ago is already in force.
 */
import { TS_SHARIAH_V1, type Classification, type PolicyVersion } from "./policy";
import { getShariahMode, type ShariahMode } from "./mode";
import * as shariahRepo from "../repositories/shariah";

/** Spot sides. Deliberately only two — no futures, margin or short semantics exist here. */
export type SpotSide = "BUY" | "SELL";

/**
 * The block carried on every Platform->Bot execution request.
 *
 * The key names are the wire contract and are frozen: `mode`, `policyVersion`,
 * `assetId`, `baseAsset`, `effectiveStatus`, `publicationId`. It travels inside
 * the request BODY, which `manualTrading/client.ts` canonicalises in full and
 * covers by the HMAC — so it is signed evidence, not an advisory header a
 * tamperer could rewrite.
 */
export interface ShariahRequestContext {
  mode: ShariahMode;
  /** TS_SHARIAH_V1 whenever mode is "enforce"; null when the mode is off. */
  policyVersion: PolicyVersion | null;
  /** The registry's own scalar identity, unconverted. Null when unresolvable. */
  assetId: string | null;
  baseAsset: string | null;
  /** Always one of the three public answers. UNSCREENED/STALE are already REVIEW. */
  effectiveStatus: Classification;
  /** The current publication this status came from; null where there legitimately is none. */
  publicationId: string | null;
}

export interface ShariahGateDecision {
  allowed: boolean;
  /** Operator-readable refusal. Null when allowed. */
  reason: string | null;
  context: ShariahRequestContext;
}

/** Raised by `assertShariahExposureAllowed`. Carries the signed context for logging. */
export class ShariahExposureBlockedError extends Error {
  readonly status = 403;
  constructor(message: string, readonly context: ShariahRequestContext) {
    super(message);
    this.name = "ShariahExposureBlockedError";
  }
}

/**
 * Trading Scene's Shariah universe is the Binance Spot USDT base-asset set, so
 * the base asset of a tradable pair is the symbol minus its USDT quote. A
 * symbol that is not USDT-quoted has no registry identity at all, which is a
 * REVIEW (blocked when enforcing), never an exemption.
 */
export function baseAssetOfSymbol(symbol: string): string | null {
  const upper = String(symbol ?? "").trim().toUpperCase();
  // Legacy suffix split, kept deliberately: this gate screens USDT pairs and
  // only USDT pairs, so the suffix IS the condition rather than a guess at
  // the quote asset. New code reads assets from metadata — `types/instrument`.
  if (!upper.endsWith("USDT")) return null;
  const base = upper.slice(0, -4);
  return base.length > 0 ? base : null;
}

/** Normalises the many spellings the call sites use ("buy", "BUY", "Sell"). */
export function normalizeSpotSide(side: unknown): SpotSide | null {
  const value = String(side ?? "").trim().toUpperCase();
  return value === "BUY" || value === "SELL" ? value : null;
}

/**
 * The rule itself, as a pure function — the thing Paper, live and manual paths
 * must all agree on, provable without a database.
 *
 * NEW EXPOSURE (BUY) is allowed only when enforcement is off, or the asset's
 * effective status is ELIGIBLE. REVIEW and EXCLUDED both refuse; UNSCREENED and
 * STALE never reach here as themselves, having already resolved to REVIEW.
 */
export function decideSpotExposure(input: {
  mode: ShariahMode;
  side: SpotSide;
  effectiveStatus: Classification;
}): { allowed: boolean; reason: string | null } {
  if (input.side === "SELL") return { allowed: true, reason: null };
  if (input.mode !== "enforce") return { allowed: true, reason: null };
  if (input.effectiveStatus === "ELIGIBLE") return { allowed: true, reason: null };
  return { allowed: false, reason: null };
}

function refusalReason(context: ShariahRequestContext, symbol: string): string {
  const name = context.baseAsset ?? symbol;
  if (context.assetId === null) {
    return `Shariah Mode is on and ${symbol} has no Shariah registry identity ` +
      "(Trading Scene screens Binance Spot USDT base assets). New exposure is blocked. " +
      "Selling or reducing an existing position is still allowed.";
  }
  if (context.effectiveStatus === "EXCLUDED") {
    return `Shariah Mode is on and ${name} is EXCLUDED under ${TS_SHARIAH_V1}. ` +
      "New exposure is blocked. Selling or reducing an existing position is still allowed.";
  }
  return `Shariah Mode is on and ${name} is not ELIGIBLE (currently REVIEW under ` +
    `${TS_SHARIAH_V1} — it is unscreened, stale, or was reviewed and found unclear). ` +
    "New exposure is blocked until a fresh screening publishes it as ELIGIBLE. " +
    "Selling or reducing an existing position is still allowed.";
}

/** Injectable for tests; production binds to the settings store and the read boundary. */
export interface ShariahGateDeps {
  readMode?: () => Promise<ShariahMode>;
  lookupBaseAsset?: (baseAsset: string) => Promise<{
    assetId: string; baseAsset: string;
    effectiveStatus: Classification; currentPublicationId: string | null;
  } | null>;
}

/**
 * Resolves the registry facts for a symbol and applies the rule. Always
 * returns a fully populated context — including when the intent is refused and
 * when the mode is off — because the same block is what gets signed onto the
 * outbound Bot request.
 */
export async function evaluateShariahGate(
  intent: { symbol: string; side: SpotSide },
  deps: ShariahGateDeps = {}
): Promise<ShariahGateDecision> {
  const readMode = deps.readMode ?? getShariahMode;
  const lookup = deps.lookupBaseAsset
    ?? (async (base: string) => shariahRepo.getAssetByBaseSymbol(base));

  const mode = await readMode();
  const baseAsset = baseAssetOfSymbol(intent.symbol);
  const asset = baseAsset ? await lookup(baseAsset) : null;

  const context: ShariahRequestContext = {
    mode,
    policyVersion: mode === "enforce" ? TS_SHARIAH_V1 : null,
    assetId: asset?.assetId ?? null,
    baseAsset: asset?.baseAsset ?? baseAsset,
    // No registry row is REVIEW, never ELIGIBLE. The repository has already
    // collapsed UNSCREENED/STALE to REVIEW through policy.ts.
    effectiveStatus: asset?.effectiveStatus ?? "REVIEW",
    publicationId: asset?.currentPublicationId ?? null,
  };

  const decision = decideSpotExposure({ mode, side: intent.side, effectiveStatus: context.effectiveStatus });
  return {
    allowed: decision.allowed,
    reason: decision.allowed ? null : refusalReason(context, String(intent.symbol).toUpperCase()),
    context,
  };
}

/**
 * ── What TS_SHARIAH_V1 actually rules on, and what it does not ────────────
 *
 * The policy's own premise is spot crypto. `policy.ts` says so, the methodology
 * document says "Spot only. There are no futures, margin or short semantics",
 * and the type above says the same: two sides, no leverage, no short.
 *
 * The derivatives route nevertheless gated a perpetual on the SPOT base
 * asset's verdict and stamped the signed block with it — so opening a short on
 * an ELIGIBLE asset passed. That is the product asserting a permissibility
 * conclusion about leverage and shorting that this policy version never made,
 * and it is the one failure mode worse than refusing: a wrong answer delivered
 * with the full apparatus of a right one.
 *
 * So the scope is checked before the asset is. Outside spot, and with
 * enforcement on, a new position is REFUSED — not because the instrument is
 * impermissible, which nothing here knows, but because nothing here knows. The
 * refusal says exactly that, and names the two honest ways out: trade it with
 * Shariah Mode off, or wait for a policy version that covers it.
 *
 * SELL is never gated, here as everywhere. An operator must always be able to
 * get out of a position, whatever the scope and whatever the mode.
 */
export type ExposureScope = "spot" | "derivative" | "equity" | "traditional";

const SCOPE_DESCRIPTION: Record<Exclude<ExposureScope, "spot">, string> = {
  derivative: "derivatives, leverage or short exposure",
  equity: "equities",
  traditional: "foreign exchange or traditional futures",
};

/** True only for the asset class this policy version has a finding about. */
export function policyCoversScope(scope: ExposureScope): boolean {
  return scope === "spot";
}

/**
 * Refuse new exposure in an asset class the policy does not rule on.
 *
 * ── Why this returns NOTHING when it allows ───────────────────────────────
 *
 * It used to return a context: the mode, the policy version when enforcing,
 * and `assetId: null, baseAsset: null` because a scope check has no asset to
 * name. The routes signed that onto the outbound request, and the Bot's
 * contract reads `mode: "enforce"` as a promise that a COMPLETE asset decision
 * follows — `webhookContract.ts` requires `assetId` and `baseAsset` to be valid
 * strings under it.
 *
 * So the block was rejected, by `readShariahContext` at the top of the Bot's
 * handler, BEFORE its entry/exit branch. Which meant a `reduceOnly` close was
 * refused: an operator enforcing Shariah Mode could not get out of a
 * derivative position. That is the one outcome this whole module says is
 * impossible, and it was caused by claiming a decision that had not been made.
 *
 * The honest shape is that there is no decision to convey. A scope the policy
 * does not rule on produces a REFUSAL or it produces silence — never a
 * half-filled decision. The Bot's own installation floor still governs, which
 * is the correct second line for a class this policy cannot speak to.
 */
export async function assertShariahScopeAllowed(
  intent: { scope: ExposureScope; side: SpotSide },
  deps: ShariahGateDeps = {}
): Promise<null> {
  // SELL is never gated, here as everywhere — and it must not be handed a
  // decision either, because a decision is what makes the far side validate one.
  if (intent.side === "SELL") return null;
  if (policyCoversScope(intent.scope)) return null;
  const mode = await (deps.readMode ?? getShariahMode)();
  if (mode !== "enforce") return null;
  const context: ShariahRequestContext = {
    mode,
    policyVersion: TS_SHARIAH_V1,
    assetId: null,
    baseAsset: null,
    effectiveStatus: "REVIEW",
    publicationId: null,
  };
  throw new ShariahExposureBlockedError(
    `Shariah Mode is on. ${TS_SHARIAH_V1} screens Binance Spot crypto assets and makes `
    + `no finding about ${SCOPE_DESCRIPTION[intent.scope as Exclude<ExposureScope, "spot">]}, `
    + "so this order is refused rather than cleared by a spot asset's verdict. Closing or "
    + "reducing an existing position is never blocked. To open one, either turn Shariah "
    + "Mode off or wait for a policy version that covers this asset class.",
    context,
  );
}

/**
 * The call every new-exposure path makes. Throws `ShariahExposureBlockedError`
 * with an operator-readable reason when refused; returns the context to sign
 * onto the outbound request when allowed.
 */
export async function assertShariahExposureAllowed(
  intent: { symbol: string; side: SpotSide },
  deps: ShariahGateDeps = {}
): Promise<ShariahRequestContext> {
  const decision = await evaluateShariahGate(intent, deps);
  if (!decision.allowed) {
    throw new ShariahExposureBlockedError(decision.reason ?? "blocked by Shariah Mode", decision.context);
  }
  return decision.context;
}
