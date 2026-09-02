import type { FastifyInstance } from "fastify";
import { manualBotRequest } from "../../manualTrading/client";
import {
  overlaysWithinRange, projectCurrentOverlays, projectHistoricalOverlays,
  type ManualOverlayStateEvidence,
} from "../../overlays/projection";
import type { TradingOverlayResponse } from "../../overlays/types";
import * as journalRepo from "../../repositories/journal";
import * as overlayRepo from "../../repositories/tradingOverlays";
import * as symbolRepo from "../../repositories/symbols";

export const MAX_OVERLAY_RANGE_MS = 366 * 86_400_000;
export const MAX_OVERLAY_ITEMS = 500;
export const DEFAULT_OVERLAY_ITEMS = 300;

export interface TradingOverlayQuery {
  symbol?: string; from?: string; to?: string; replayCutoff?: string; limit?: string;
  scope?: string;
}
export type ParsedTradingOverlayQuery = {
  symbol: string; from: Date; to: Date; toExclusive: Date;
  replayCutoff: Date | null; limit: number; scope: "all" | "historical" | "current";
};
type ParseResult = { ok: true; value: ParsedTradingOverlayQuery } | { ok: false; error: string };
const SYMBOL = /^[A-Z0-9]{5,20}$/;
const integer = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_OVERLAY_ITEMS;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_OVERLAY_ITEMS ? parsed : null;
};
const instant = (value: string | undefined): Date | null => {
  if (!value) return null;
  const millis = Number(value);
  const date = new Date(Number.isFinite(millis) ? millis : value);
  return Number.isFinite(date.getTime()) ? date : null;
};

export function parseTradingOverlayQuery(query: TradingOverlayQuery): ParseResult {
  const symbol = query.symbol?.trim().toUpperCase() ?? "";
  if (!SYMBOL.test(symbol)) return { ok: false, error: "symbol must contain 5 to 20 uppercase letters or digits" };
  const from = instant(query.from); const requestedTo = instant(query.to);
  if (!from || !requestedTo) return { ok: false, error: "from and to must be valid timestamps" };
  const replayCutoff = query.replayCutoff === undefined ? null : instant(query.replayCutoff);
  if (query.replayCutoff !== undefined && !replayCutoff) {
    return { ok: false, error: "replayCutoff must be a valid timestamp" };
  }
  const to = replayCutoff && replayCutoff < requestedTo ? replayCutoff : requestedTo;
  if (from > to || to.getTime() - from.getTime() > MAX_OVERLAY_RANGE_MS) {
    return { ok: false, error: "range must be ordered and no longer than 366 days" };
  }
  if (replayCutoff && replayCutoff < from) {
    return { ok: false, error: "replayCutoff must not precede from" };
  }
  const limit = integer(query.limit);
  if (limit === null) return { ok: false, error: `limit must be an integer from 1 to ${MAX_OVERLAY_ITEMS}` };
  const scope = query.scope ?? "all";
  if (!(["all", "historical", "current"] as string[]).includes(scope)) {
    return { ok: false, error: "scope must be all, historical, or current" };
  }
  return { ok: true, value: { symbol, from, to,
    toExclusive: new Date(to.getTime() + 1), replayCutoff, limit,
    scope: scope as ParsedTradingOverlayQuery["scope"] } };
}

export function overlayReadPlan(query: ParsedTradingOverlayQuery): {
  historical: boolean; current: boolean; manualState: boolean;
} {
  const historical = query.scope !== "current";
  const current = query.scope !== "historical" && !query.replayCutoff;
  return { historical, current, manualState: !query.replayCutoff && (historical || current) };
}

interface ManualStateWire {
  dryRun?: boolean;
  accounts?: Array<{ id: string; testnet?: boolean; mode?: string }>;
  orders?: Array<Record<string, unknown>>;
  positions?: Array<Record<string, unknown>>;
}
const time = (value: unknown): number => typeof value === "string" ? Date.parse(value) : Number.NaN;
const number = (value: unknown): number | null =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
function manualState(raw: ManualStateWire, symbol: string, observedAt: number): ManualOverlayStateEvidence {
  const orders = (raw.orders ?? []).flatMap((order) => {
    if (String(order.symbol ?? "").toUpperCase() !== symbol || !["BUY", "SELL"].includes(String(order.side))) return [];
    const createdAt = time(order.createdAt); const updatedAt = time(order.updatedAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || !order.id) return [];
    const completedAt = time(order.completedAt); const submittedAt = time(order.submittedAt);
    return [{ id: String(order.id), requestId: order.requestId ? String(order.requestId) : null,
      clientOrderId: order.clientOrderId ? String(order.clientOrderId) : null,
      exchangeOrderId: order.exchangeOrderId ? String(order.exchangeOrderId) : null,
      exchangeAccountId: order.exchangeAccountId ? String(order.exchangeAccountId) : null,
      symbol, side: String(order.side) as "BUY" | "SELL", status: String(order.status ?? "unknown"),
      createdAt, submittedAt: Number.isFinite(submittedAt) ? submittedAt : null,
      completedAt: Number.isFinite(completedAt) ? completedAt : null, updatedAt,
      filledBaseQty: number(order.filledBaseQty) ?? 0,
      averageFillPrice: number(order.averageFillPrice), orderType: order.orderType ? String(order.orderType) : null,
      limitPrice: number(order.limitPrice), requestedBaseQty: number(order.requestedBaseQty) }];
  });
  const positions = (raw.positions ?? []).flatMap((position) => {
    if (String(position.pair ?? "").toUpperCase() !== symbol || !position.id) return [];
    const createdAt = time(position.createdAt);
    const updatedAtValue = time(position.updatedAt);
    const updatedAt = Number.isFinite(updatedAtValue) ? updatedAtValue : observedAt;
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return [];
    return [{ id: String(position.id), exchangeAccountId: String(position.exchangeAccountId ?? ""),
      pair: symbol, status: String(position.status ?? "unknown"), entryPrice: number(position.entryPrice),
      quantity: number(position.quantity) ?? 0, createdAt, updatedAt }];
  });
  return { dryRun: Boolean(raw.dryRun), accounts: raw.accounts ?? [], orders, positions };
}

export async function tradingOverlayRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: TradingOverlayQuery }>("/api/trading-overlays", async (req, reply) => {
    const parsed = parseTradingOverlayQuery(req.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const q = parsed.value;
    const spot = await symbolRepo.getSymbol(q.symbol);
    if (!spot) return reply.code(404).send({ error: "Spot symbol is not tracked" });
    const sourceLimit = q.limit + 1;
    const filter = { from: q.from, toExclusive: q.toExclusive, symbol: q.symbol,
      deploymentId: null, strategyId: null, limit: sourceLimit };
    // Replay never performs the current Manual/Bot state read. That source cannot
    // prove what was knowable at T, so Manual history is omitted in Replay.
    const plan = overlayReadPlan(q);
    const wantsHistorical = plan.historical;
    const wantsCurrent = plan.current;
    const wantsManual = plan.manualState;
    const [realizations, activity, paper, manualRead] = await Promise.all([
      wantsHistorical ? journalRepo.listAutomatedRealizations(filter) : Promise.resolve([]),
      wantsHistorical ? journalRepo.listAutomatedActivity(filter) : Promise.resolve([]),
      wantsHistorical ? journalRepo.listPaperFills(filter) : Promise.resolve([]),
      !wantsManual ? Promise.resolve({ state: undefined, unavailable: false })
        : manualBotRequest<ManualStateWire>({ method: "GET",
          path: `/api/manual-trading/state?symbol=${encodeURIComponent(q.symbol)}` })
          .then((state) => ({ state, unavailable: false }))
          .catch(() => ({ state: undefined, unavailable: true })),
    ]);
    const manual = manualRead.state ? manualState(manualRead.state, q.symbol, Date.now()) : undefined;
    const historicalManual = wantsHistorical && manual ? { ...manual, positions: [], orders: manual.orders.filter((order) =>
      order.completedAt !== null && order.completedAt >= q.from.getTime()
        && order.completedAt <= q.to.getTime()) } : undefined;
    const projectedHistorical = wantsHistorical
      ? projectHistoricalOverlays({ symbol: q.symbol, manual: historicalManual,
        automatedActivity: activity, automatedRealizations: realizations, paperFills: paper,
        limit: q.limit })
      : { items: [], truncated: false };
    const historical = { ...projectedHistorical, items: overlaysWithinRange(
      projectedHistorical.items, q.from.getTime(), q.to.getTime()) };
    const sourceTruncated = [realizations, activity, paper].some((rows) => rows.length > q.limit);
    let currentItems: ReturnType<typeof projectCurrentOverlays> = [];
    if (wantsCurrent) {
      const [orders, automatedPositions, paperPositions] = await Promise.all([
        overlayRepo.listCurrentAutomatedOrders(q.symbol, sourceLimit),
        overlayRepo.listCurrentAutomatedPositions(q.symbol, sourceLimit),
        overlayRepo.listCurrentPaperPositions(q.symbol, sourceLimit),
      ]);
      currentItems = projectCurrentOverlays({ symbol: q.symbol, manual,
        automatedOrders: orders, positions: [...automatedPositions, ...paperPositions] });
    }
    const room = Math.max(0, q.limit - historical.items.length);
    const currentTruncated = currentItems.length > room;
    const items = [...historical.items, ...currentItems.slice(0, room)];
    const truncated = sourceTruncated || historical.truncated || currentTruncated;
    const response: TradingOverlayResponse = {
      symbol: q.symbol, range: { from: q.from.toISOString(), to: q.to.toISOString(),
        replayCutoff: q.replayCutoff?.toISOString() ?? null }, items, truncated, limit: q.limit,
      limitations: [
        "Manual and automated cumulative order snapshots are never relabeled as individual exchange fills.",
        "Manual positions come only from explicit ManualPosition state; ManualOrders are never paired to invent cost basis.",
        ...(q.replayCutoff ? ["Replay omits all current state and Manual history because its source is a live current-state read."] : []),
        ...(manualRead.unavailable ? ["Manual overlays are unavailable because the single bounded Manual state read failed."] : []),
        ...(truncated ? [`Overlay evidence reached the deterministic ${q.limit}-item response bound.`] : []),
      ],
    };
    return response;
  });
}
