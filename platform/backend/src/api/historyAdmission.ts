import type { FastifyReply, FastifyRequest } from "fastify";
import { isAdmin, userIdOf } from "../security/requestUser";

/**
 * The most SOURCE bars one history request may cover for an ordinary account
 * (backfill/ensure in `routes/data.ts`, the market candles GET in
 * `routes/marketCatalog.ts`); a longer request is clamped to the newest bars,
 * not refused.
 *
 * The chart's default depth backfills ceil(10,000 * 1.1) = 11,000 bars of a
 * native resolution, but a derived resolution multiplies that by its factor
 * (5s is 55,000 one-second bars; 25m is 55,000 five-minute bars). The ceiling
 * is therefore the same 200,000 source rows the candles GET will serve
 * (`MAX_SOURCE_ROWS` in `data/resolvedCandles`): a window the chart could never
 * draw is refused; everything it can draw is allowed. 200,000 bars is ~30 MB
 * held for one request, bounded further by the in-flight limits below. Without
 * a ceiling any signed-in account could make the API process (which also hosts
 * LiveRunner) hold years of 1m bars in memory at once. The admin is not capped:
 * their large backfills stream instead (see `routes/data.ts`).
 */
export const USER_MAX_HISTORY_BARS = 200_000;

/**
 * Source bars from which an ordinary account's request counts as heavy.
 *
 * Below this it takes no slot: a chart's default depth (11,000 native bars) and
 * its tail repairs (a handful of bars) hold about 3 MB at most, and gating them
 * made a layout with more panes than slots fail to load or silently keep stale
 * candles. A derived resolution's deep window (55,000 source bars) is heavy.
 */
export const USER_HEAVY_HISTORY_BARS = 20_000;

/** Heavy history requests one ordinary account may have running at once. */
export const USER_MAX_HISTORY_IN_FLIGHT = 2;

/**
 * Heavy history requests ALL ordinary accounts together may have running at
 * once, across every route. A per-account cap alone does not bound memory, and
 * this process also hosts LiveRunner on a 916 MB t3.micro by default: at ~30 MB
 * each this holds the worst case near 120 MB however many accounts sign up.
 */
export const SERVER_MAX_HISTORY_IN_FLIGHT = 4;

/** What a refused request is told; `lib/api.ts` waits this long and asks again. */
const RETRY_AFTER_SECONDS = 2;

export type HistoryAdmission = (
  req: FastifyRequest, reply: FastifyReply,
  /** Source bars the request covers; omitted means the caller already judged it heavy. */
  sourceBars?: number,
) => { ok: false } | { ok: true; release: () => void };

const NOTHING_HELD = { ok: true as const, release: () => {} };

/*
 * The caps on heavy history work running at once (the span itself is clamped by
 * each route). The admin is exempt and is not counted. `ok: false` means it has
 * replied 429.
 */
export function createHistoryAdmission(
  limits: { perAccount: number; server: number } = {
    perAccount: USER_MAX_HISTORY_IN_FLIGHT, server: SERVER_MAX_HISTORY_IN_FLIGHT,
  },
): HistoryAdmission {
  const inFlight = new Map<string, number>();
  let total = 0;
  return (req, reply, sourceBars = Infinity) => {
    if (isAdmin(req) || sourceBars <= USER_HEAVY_HISTORY_BARS) return NOTHING_HELD;
    const user = userIdOf(req);
    const running = inFlight.get(user) ?? 0;
    if (running >= limits.perAccount || total >= limits.server) {
      void reply.code(429).header("retry-after", String(RETRY_AFTER_SECONDS)).send({
        error: running >= limits.perAccount
          ? `This account already has ${running} history requests loading; ` +
            "wait for one to finish and try again."
          : "The server is busy loading history for other accounts; try again shortly.",
      });
      return { ok: false };
    }
    inFlight.set(user, running + 1);
    total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        total -= 1;
        const left = (inFlight.get(user) ?? 1) - 1;
        if (left <= 0) inFlight.delete(user); else inFlight.set(user, left);
      },
    };
  };
}

/** The one set of slots every history route shares, so the server-wide cap means what it says. */
export const admitHistoryRequest = createHistoryAdmission();
