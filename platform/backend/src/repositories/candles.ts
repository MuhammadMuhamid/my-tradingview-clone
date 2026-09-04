import { query } from "../db/pool";
import type { Candle, Interval } from "../types/market";

const COLS = 11;
// Postgres caps bind parameters at 65535; stay well under it per statement.
const MAX_BATCH = 5000;

interface CandleRow {
  symbol: string;
  interval: Interval;
  open_time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number | null;
  trade_count: number | null;
  close_time: Date;
}

function toCandle(r: CandleRow): Candle {
  return {
    symbol: r.symbol,
    interval: r.interval,
    openTime: r.open_time.getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quote_volume ?? undefined,
    tradeCount: r.trade_count ?? undefined,
    closeTime: r.close_time.getTime(),
  };
}

/** Idempotent bulk upsert — re-fetching a range or a live-updated open candle just overwrites. */
export async function upsertCandles(candles: Candle[]): Promise<number> {
  for (let start = 0; start < candles.length; start += MAX_BATCH) {
    const batch = candles.slice(start, start + MAX_BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((c, i) => {
      const o = i * COLS;
      values.push(
        c.symbol, c.interval, new Date(c.openTime),
        c.open, c.high, c.low, c.close, c.volume,
        c.quoteVolume ?? null, c.tradeCount ?? null, new Date(c.closeTime)
      );
      return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`;
    });
    await query(
      `INSERT INTO candles
         (symbol, interval, open_time, open, high, low, close, volume, quote_volume, trade_count, close_time)
       VALUES ${tuples.join(",")}
       ON CONFLICT (symbol, interval, open_time) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume,
         quote_volume = EXCLUDED.quote_volume, trade_count = EXCLUDED.trade_count,
         close_time = EXCLUDED.close_time`,
      values
    );
  }
  return candles.length;
}

/** Ascending range read for the engine / chart API. Bounds are ms epoch, inclusive. */
export async function getCandles(
  symbol: string,
  interval: Interval,
  opts: { from?: number; to?: number; limit?: number } = {}
): Promise<Candle[]> {
  const cond: string[] = ["symbol = $1", "interval = $2"];
  const params: unknown[] = [symbol, interval];
  if (opts.from !== undefined) {
    params.push(new Date(opts.from));
    cond.push(`open_time >= $${params.length}`);
  }
  if (opts.to !== undefined) {
    params.push(new Date(opts.to));
    cond.push(`open_time <= $${params.length}`);
  }

  // With only a limit (no lower bound), take the newest N then flip ascending.
  if (opts.limit !== undefined && opts.from === undefined) {
    params.push(opts.limit);
    const { rows } = await query<CandleRow>(
      `SELECT * FROM (
         SELECT * FROM candles WHERE ${cond.join(" AND ")}
         ORDER BY open_time DESC LIMIT $${params.length}
       ) sub ORDER BY open_time ASC`,
      params
    );
    return rows.map(toCandle);
  }

  let limitSql = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limitSql = ` LIMIT $${params.length}`;
  }
  const { rows } = await query<CandleRow>(
    `SELECT * FROM candles WHERE ${cond.join(" AND ")} ORDER BY open_time ASC${limitSql}`,
    params
  );
  return rows.map(toCandle);
}

/** Open time (ms) of the newest stored bar, or null — drives incremental backfill. */
export async function latestOpenTime(
  symbol: string,
  interval: Interval
): Promise<number | null> {
  const { rows } = await query<{ open_time: Date }>(
    "SELECT open_time FROM candles WHERE symbol = $1 AND interval = $2 ORDER BY open_time DESC LIMIT 1",
    [symbol, interval]
  );
  return rows[0] ? rows[0].open_time.getTime() : null;
}

/**
 * Stored row count and first/last open time inside an explicit window.
 *
 * Operator backfills need to report what actually landed for the range they
 * asked for, not the whole table; this keeps that single aggregate in the
 * repository rather than growing another ad-hoc query in a script.
 */
export async function coverage(
  symbol: string,
  interval: Interval,
  from: number,
  to: number
): Promise<{ rows: number; firstOpenTime: number | null; lastOpenTime: number | null }> {
  const { rows } = await query<{ n: number; first: Date | null; last: Date | null }>(
    `SELECT count(*)::bigint AS n, min(open_time) AS first, max(open_time) AS last
       FROM candles
      WHERE symbol = $1 AND interval = $2 AND open_time >= $3 AND open_time <= $4`,
    [symbol, interval, new Date(from), new Date(to)]
  );
  const r = rows[0];
  return {
    rows: r?.n ?? 0,
    firstOpenTime: r?.first ? r.first.getTime() : null,
    lastOpenTime: r?.last ? r.last.getTime() : null,
  };
}

export async function countCandles(
  symbol: string,
  interval: Interval
): Promise<number> {
  const { rows } = await query<{ n: number }>(
    "SELECT count(*)::bigint AS n FROM candles WHERE symbol = $1 AND interval = $2",
    [symbol, interval]
  );
  return rows[0]?.n ?? 0;
}
