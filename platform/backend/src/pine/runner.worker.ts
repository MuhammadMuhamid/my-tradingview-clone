/**
 * Pine execution worker.
 *
 * `BE-23`: `/api/pine/run` executed a user-supplied script on the API's own
 * event loop with a 45-second budget. A single heavy script therefore stalled
 * every other request on that process — including the live alert runner's
 * database work and the webhook dispatcher — for as long as it ran.
 *
 * The interpreter is unchanged. It simply runs here instead, on a worker thread
 * with its own heap, so the only thing a runaway script can starve is itself.
 * The parent enforces the wall clock by terminating this thread; the
 * interpreter's own deadline is the cooperative first line of defence.
 */
import { parentPort, workerData } from "node:worker_threads";
import { Broker, type BrokerOptions } from "../engine/broker";
import { computeMetrics, downsampleEquity, toTradeRecords } from "../engine/metrics";
import { PineInterpreter, PineRuntimeError } from "./interpreter";
import { PineSyntaxError } from "./lexer";
import type { Bars } from "../engine/mtf";

export interface PineWorkerRequest {
  source: string;
  bars: Bars;
  startIdx: number;
  endIdx: number;
  params?: Record<string, number | string | boolean>;
  broker: BrokerOptions | null;
  timeBudgetMs: number;
  /** Extra feeds for cross-timeframe `request.security`, keyed by timeframe. */
  htf?: Record<string, Bars>;
}

export type PineWorkerResponse =
  | { kind: "ok"; run: Record<string, unknown> }
  | { kind: "script-error"; errors: { line: number; col: number; message: string }[] }
  | { kind: "crash"; message: string };

/** Script-level failures are results, not thread failures. */
function scriptErrors(err: unknown): { line: number; col: number; message: string }[] | null {
  if (err instanceof PineSyntaxError) return [{ line: err.line, col: err.col, message: err.message }];
  if (err instanceof PineRuntimeError) return [{ line: err.line, col: 1, message: err.message }];
  // A pathological script can exhaust the JS stack before the parser's own
  // depth guard trips. Report it as a script error, not a crash.
  if (err instanceof RangeError) {
    return [{ line: 1, col: 1, message: "script is too complex to compile (call stack exhausted)" }];
  }
  return null;
}

export function executePine(req: PineWorkerRequest): PineWorkerResponse {
  try {
    const broker = req.broker ? new Broker(req.broker) : undefined;
    const interp = new PineInterpreter(req.source);
    const out = interp.run({
      bars: req.bars,
      startIdx: req.startIdx,
      endIdx: req.endIdx,
      params: req.params,
      broker,
      timeBudgetMs: req.timeBudgetMs,
      htf: req.htf,
    });
    return {
      kind: "ok",
      run: {
        meta: out.meta,
        times: out.times,
        plots: out.plots,
        hlines: out.hlines,
        shapes: out.shapes,
        drawings: out.drawings,
        ...(broker
          ? {
              trades: toTradeRecords(broker.closed),
              metrics: computeMetrics(
                broker.closed, out.equityCurve,
                broker.opts.initialCapital, broker.commissionPaid
              ),
              equityCurve: downsampleEquity(out.equityCurve),
            }
          : {}),
      },
    };
  } catch (err) {
    const errors = scriptErrors(err);
    if (errors) return { kind: "script-error", errors };
    return { kind: "crash", message: (err as Error).message };
  }
}

if (parentPort) {
  parentPort.postMessage(executePine(workerData as PineWorkerRequest));
}
