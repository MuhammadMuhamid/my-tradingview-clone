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
 * held for one request, bounded further by the in-flight limit below. Without
 * a ceiling any signed-in account could make the API process (which also hosts
 * LiveRunner) hold years of 1m bars in memory at once. The admin is not capped:
 * their large backfills stream instead (see `routes/data.ts`).
 */
export const USER_MAX_HISTORY_BARS = 200_000;

/** Heavy history requests one ordinary account may have running at once. */
export const USER_MAX_HISTORY_IN_FLIGHT = 4;

export type HistoryAdmission = (
  req: FastifyRequest, reply: FastifyReply,
) => { ok: false } | { ok: true; release: () => void };

/*
 * A per-account cap on heavy history work running at once (the span itself is
 * clamped by each route). The admin is exempt. `ok: false` means it has
 * replied 429. Each call makes its own counter, so a route plugin's slots are
 * its own: `routes/data.ts` (backfill + ensure share one) and the market
 * candles route (cache-bypassing reads) each hold one.
 */
export function createHistoryAdmission(): HistoryAdmission {
  const inFlight = new Map<string, number>();
  return (req, reply) => {
    if (isAdmin(req)) return { ok: true, release: () => {} };
    const user = userIdOf(req);
    const running = inFlight.get(user) ?? 0;
    if (running >= USER_MAX_HISTORY_IN_FLIGHT) {
      void reply.code(429).header("retry-after", "5").send({
        error: `This account already has ${running} history requests loading; ` +
          "wait for one to finish and try again.",
      });
      return { ok: false };
    }
    inFlight.set(user, running + 1);
    return {
      ok: true,
      release: () => {
        const left = (inFlight.get(user) ?? 1) - 1;
        if (left <= 0) inFlight.delete(user); else inFlight.set(user, left);
      },
    };
  };
}
