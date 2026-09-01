import type { FastifyInstance } from "fastify";
import { manualBotRequest } from "../../manualTrading/client";
import {
  automatedActivityRows, automatedRealizationRows, manualActivityRows, paperFillRows,
  summarizeJournal, type ManualActivityEvidence,
} from "../../journal/projection";
import type { JournalPeriod, JournalResponse, JournalSource } from "../../journal/types";
import * as journalRepo from "../../repositories/journal";

export const MAX_JOURNAL_RANGE_DAYS = 366;
export const MAX_JOURNAL_PAGE_SIZE = 100;
export const MAX_JOURNAL_PAGE = 100;
export const JOURNAL_SUMMARY_SCAN_LIMIT = 10_000;

export interface JournalQuery {
  from?: string;
  to?: string;
  source?: string;
  symbol?: string;
  deploymentId?: string;
  strategyId?: string;
  period?: string;
  page?: string;
  limit?: string;
}

export interface ParsedJournalQuery {
  from: Date;
  toExclusive: Date;
  sources: JournalSource[];
  symbol: string | null;
  deploymentId: string | null;
  strategyId: number | null;
  period: JournalPeriod;
  page: number;
  limit: number;
}

type ParseResult = { ok: true; value: ParsedJournalQuery } | { ok: false; error: string };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES: JournalSource[] = ["MANUAL", "AUTOMATED", "PAPER"];

function integer(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function utcDate(value: string): Date | null {
  if (!DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function parseJournalQuery(query: JournalQuery, now = new Date()): ParseResult {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const defaultFrom = new Date(today.getTime() - 29 * 86_400_000);
  const from = query.from ? utcDate(query.from) : defaultFrom;
  const inclusiveTo = query.to ? utcDate(query.to) : today;
  if (!from || !inclusiveTo) return { ok: false, error: "from and to must be valid YYYY-MM-DD dates" };
  const toExclusive = new Date(inclusiveTo.getTime() + 86_400_000);
  const rangeDays = (toExclusive.getTime() - from.getTime()) / 86_400_000;
  if (rangeDays < 1 || rangeDays > MAX_JOURNAL_RANGE_DAYS) {
    return { ok: false, error: `date range must be between 1 and ${MAX_JOURNAL_RANGE_DAYS} days` };
  }
  const source = query.source?.toUpperCase();
  if (source && !SOURCES.includes(source as JournalSource)) {
    return { ok: false, error: "source must be MANUAL, AUTOMATED, or PAPER" };
  }
  const symbol = query.symbol?.trim().toUpperCase() || null;
  if (symbol && !/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return { ok: false, error: "symbol must contain 5 to 20 uppercase letters or digits" };
  }
  const deploymentId = query.deploymentId?.trim() || null;
  if (deploymentId && !UUID.test(deploymentId)) {
    return { ok: false, error: "deploymentId must be a UUID" };
  }
  const strategyId = query.strategyId === undefined ? null
    : integer(query.strategyId, 0, 1, 2_147_483_647);
  if (strategyId === null && query.strategyId !== undefined) {
    return { ok: false, error: "strategyId must be a positive integer" };
  }
  const period = (query.period ?? "day") as JournalPeriod;
  if (!["day", "week", "month"].includes(period)) {
    return { ok: false, error: "period must be day, week, or month" };
  }
  const page = integer(query.page, 1, 1, MAX_JOURNAL_PAGE);
  const limit = integer(query.limit, 50, 1, MAX_JOURNAL_PAGE_SIZE);
  if (page === null || limit === null) {
    return { ok: false, error: `page must be 1..${MAX_JOURNAL_PAGE} and limit must be 1..${MAX_JOURNAL_PAGE_SIZE}` };
  }
  return { ok: true, value: {
    from, toExclusive, sources: source ? [source as JournalSource] : SOURCES,
    symbol, deploymentId, strategyId, period, page, limit,
  } };
}

interface ManualState {
  orders?: Array<{
    id: string; requestId?: string | null; clientOrderId?: string | null;
    exchangeOrderId?: string | null; symbol: string; side: "BUY" | "SELL";
    status: string; createdAt: string; submittedAt?: string | null;
    completedAt?: string | null; updatedAt: string; filledBaseQty?: number;
    averageFillPrice?: number | null;
  }>;
}

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function manualEvidence(state: ManualState, query: ParsedJournalQuery): ManualActivityEvidence[] {
  if (query.deploymentId || query.strategyId !== null) return [];
  return (state.orders ?? []).flatMap((order) => {
    const createdAt = time(order.createdAt);
    const updatedAt = time(order.updatedAt);
    if (createdAt === null || updatedAt === null || !["BUY", "SELL"].includes(order.side)) return [];
    const row: ManualActivityEvidence = {
      id: order.id, requestId: order.requestId ?? null,
      clientOrderId: order.clientOrderId ?? null, exchangeOrderId: order.exchangeOrderId ?? null,
      symbol: order.symbol.toUpperCase(), side: order.side, status: order.status,
      createdAt, submittedAt: time(order.submittedAt), completedAt: time(order.completedAt),
      updatedAt, filledBaseQty: Number(order.filledBaseQty ?? 0),
      averageFillPrice: order.averageFillPrice ?? null,
    };
    const occurredAt = row.completedAt ?? row.submittedAt ?? row.createdAt;
    return occurredAt >= query.from.getTime() && occurredAt < query.toExclusive.getTime()
      && (!query.symbol || row.symbol === query.symbol) ? [row] : [];
  }).sort((a, b) =>
    (b.completedAt ?? b.submittedAt ?? b.createdAt) - (a.completedAt ?? a.submittedAt ?? a.createdAt));
}

export async function journalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: JournalQuery }>("/api/journal", async (req, reply) => {
    const parsed = parseJournalQuery(req.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const q = parsed.value;
    const scanLimit = JOURNAL_SUMMARY_SCAN_LIMIT + 1;
    const filter = { from: q.from, toExclusive: q.toExclusive, symbol: q.symbol,
      deploymentId: q.deploymentId, strategyId: q.strategyId, limit: scanLimit };
    const [realizations, activity, paper, manual] = await Promise.all([
      q.sources.includes("AUTOMATED") ? journalRepo.listAutomatedRealizations(filter) : Promise.resolve([]),
      q.sources.includes("AUTOMATED") ? journalRepo.listAutomatedActivity(filter) : Promise.resolve([]),
      q.sources.includes("PAPER") ? journalRepo.listPaperFills(filter) : Promise.resolve([]),
      q.sources.includes("MANUAL") && !q.deploymentId && q.strategyId === null
        ? manualBotRequest<ManualState>({ method: "GET", path:
          `/api/manual-trading/state${q.symbol ? `?symbol=${encodeURIComponent(q.symbol)}` : ""}` })
          .then((state) => ({ state, unavailable: false })).catch(() => ({ state: {}, unavailable: true }))
        : Promise.resolve({ state: {}, unavailable: false }),
    ]);
    const sourceTruncated = realizations.length > JOURNAL_SUMMARY_SCAN_LIMIT
      || activity.length > JOURNAL_SUMMARY_SCAN_LIMIT || paper.length > JOURNAL_SUMMARY_SCAN_LIMIT;
    const manualRows = manualEvidence(manual.state, q);
    const manualTruncated = manualRows.length > JOURNAL_SUMMARY_SCAN_LIMIT;
    const allRows = [
      ...automatedRealizationRows(realizations.slice(0, JOURNAL_SUMMARY_SCAN_LIMIT)),
      ...automatedActivityRows(activity.slice(0, JOURNAL_SUMMARY_SCAN_LIMIT)),
      ...paperFillRows(paper.slice(0, JOURNAL_SUMMARY_SCAN_LIMIT)),
      ...manualActivityRows(manualRows.slice(0, JOURNAL_SUMMARY_SCAN_LIMIT)),
    ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
    const offset = (q.page - 1) * q.limit;
    const pageRows = allRows.slice(offset, offset + q.limit);
    const truncated = sourceTruncated || manualTruncated;
    const response: JournalResponse = {
      rows: pageRows,
      page: { number: q.page, limit: q.limit, hasNext: allRows.length > offset + q.limit },
      range: { from: q.from.toISOString(), toExclusive: q.toExclusive.toISOString(), period: q.period },
      summary: summarizeJournal(allRows, q.period, truncated),
      limitations: [
        "Real automated summaries use Platform-owned persisted realization rows only; the Journal makes no per-intent Bot history calls.",
        "Manual rows come from one current bounded state read and remain activity with unknown economics; manual BUY and SELL orders are never paired.",
        "Exchange fill and commission history that is not persisted remains unavailable rather than estimated.",
        ...(manual.unavailable ? ["Manual activity is unavailable because the current ManualOrder state read failed."] : []),
        ...(truncated ? [`Summary evidence exceeded the hard scan bound of ${JOURNAL_SUMMARY_SCAN_LIMIT} rows per source and is explicitly truncated.`] : []),
      ],
    };
    return response;
  });
}
