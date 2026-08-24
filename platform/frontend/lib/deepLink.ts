/**
 * The optimizer's "apply to chart" deep link, parsed and validated.
 *
 * ── FE-06 ──────────────────────────────────────────────────────────────────
 *
 * Opening a URL like
 *
 *   /chart?applyStrategy=ma_rr_v9&applySymbol=BTCUSDT&layoutName=whatever
 *
 * used to act on page load with no gesture at all: it saved a named layout to
 * the server and started a backtest. A link in a message, an email or a stale
 * bookmark therefore wrote server state on behalf of whoever opened it, which
 * is the shape of a cross-site request forgery even though the endpoint is the
 * user's own.
 *
 * `applyPayload` made it worse: a base64 JSON blob decoded straight into an
 * `OptimizerBest` and used without any check, so a link could dictate the
 * strategy parameters, the starting capital, the commission and the position
 * size that were then persisted under a layout name it also chose.
 *
 * The fix has two halves and both are here rather than in the page, so they can
 * be tested without a browser:
 *
 *   1. Parsing NEVER acts. It returns a description of what the link wants,
 *      which the page shows and the user confirms. One click, and no link can
 *      write anything by being opened.
 *   2. A payload is validated field by field before it is trusted. Anything
 *      malformed falls back to the ranked lookup, which is a server response.
 */
import type { OptimizerBest } from "@/lib/api";
import type { Interval } from "@/lib/types";

/** The strategies the chart knows how to apply from a link. */
export const LINKABLE_STRATEGIES = ["srtrend_v10", "ma_rr_v9", "mtf_lean"] as const;
export type LinkableStrategy = (typeof LINKABLE_STRATEGIES)[number];

export const STRATEGY_LABELS: Record<LinkableStrategy, string> = {
  srtrend_v10: "SRTrend",
  ma_rr_v9: "MA+R:R",
  mtf_lean: "MTF Lean",
};

export interface ApplyRequest {
  strategy: LinkableStrategy;
  symbol: string;
  timeframe: Interval;
  rank: number;
  /** Non-empty when the link also wants a named layout saved to the server. */
  layoutName: string;
  /** A validated frozen result, or null to look the rank up from the server. */
  payload: OptimizerBest | null;
  /** True when the payload was present but did not survive validation. */
  payloadRejected: boolean;
}

const isStrategy = (v: string): v is LinkableStrategy =>
  (LINKABLE_STRATEGIES as readonly string[]).includes(v);

/** Symbols are interpolated into API paths and websocket stream names. */
const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;

/**
 * Describe what a link is asking for. Returns null when the URL carries no
 * apply request, or carries one that cannot be honoured.
 *
 * This function performs no I/O and changes nothing.
 */
export function parseApplyLink(search: string): ApplyRequest | null {
  const q = new URLSearchParams(search);
  const strategy = q.get("applyStrategy") ?? "";
  if (!isStrategy(strategy)) return null;

  const symbol = (q.get("applySymbol") ?? "").toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return null;

  const timeframe: Interval = q.get("applyTf") === "5m" ? "5m" : "15m";

  const rawRank = Number(q.get("applyRank") ?? 1);
  // A non-integer or absurd rank is a malformed link, not a request for rank 1:
  // silently rounding it would apply a result the user did not ask for.
  if (!Number.isInteger(rawRank) || rawRank < 1 || rawRank > 10_000) return null;

  // A layout name is written to the server, so it is bounded here rather than
  // relying on the API to reject whatever a link supplies.
  const layoutName = (q.get("layoutName") ?? "").trim().slice(0, 80);

  const encoded = q.get("applyPayload");
  const payload = encoded ? decodePayload(encoded) : null;

  return {
    strategy, symbol, timeframe, rank: rawRank, layoutName, payload,
    payloadRejected: encoded !== null && payload === null,
  };
}

/** Base64url → JSON → a validated `OptimizerBest`, or null. */
export function decodePayload(encoded: string): OptimizerBest | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return validateOptimizerBest(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    // Malformed base64, malformed JSON, or a shape that failed validation. The
    // caller falls back to asking the server for the ranked result.
    return null;
  }
}

const INTERVALS = new Set<string>(
  ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"]
);

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Accept a frozen optimizer result only if every field the chart will actually
 * use is present and of the right type.
 *
 * The properties are the ones that matter: they become the initial capital,
 * commission and position size of a backtest, and are persisted into a layout.
 * A link should not be able to set them to a string, a negative number or
 * `Infinity` and have that survive into saved state.
 */
export function validateOptimizerBest(value: unknown): OptimizerBest | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (typeof v.symbol !== "string" || !SYMBOL_RE.test(v.symbol.toUpperCase())) return null;
  if (typeof v.strategyKey !== "string" || !isStrategy(v.strategyKey)) return null;
  if (typeof v.timeframe !== "string" || !INTERVALS.has(v.timeframe)) return null;
  if (typeof v.params !== "object" || v.params === null) return null;

  const p = v.properties as Record<string, unknown> | undefined;
  if (typeof p !== "object" || p === null) return null;
  if (!finite(p.initialCapital) || p.initialCapital <= 0) return null;
  if (!finite(p.commissionPct) || p.commissionPct < 0 || p.commissionPct > 100) return null;
  if (!finite(p.slippageTicks) || p.slippageTicks < 0) return null;
  if (!finite(p.qtyCash) || p.qtyCash < 0) return null;
  if (p.qtyType !== "percent_of_equity" && p.qtyType !== "cash") return null;
  if (!finite(p.qtyValue) || p.qtyValue < 0) return null;
  if (typeof p.rangeStart !== "string" || typeof p.rangeEnd !== "string") return null;
  if (Number.isNaN(Date.parse(p.rangeStart)) || Number.isNaN(Date.parse(p.rangeEnd))) return null;

  return value as OptimizerBest;
}

/** One sentence naming everything the link will do, for the confirmation. */
export function describeApply(request: ApplyRequest): string {
  const parts = [
    `${STRATEGY_LABELS[request.strategy]} ${request.timeframe} ${request.symbol} rank #${request.rank}`,
  ];
  if (request.layoutName) parts.push(`save it as the layout "${request.layoutName}"`);
  parts.push("run a backtest over its range");
  return parts.join(", then ");
}
