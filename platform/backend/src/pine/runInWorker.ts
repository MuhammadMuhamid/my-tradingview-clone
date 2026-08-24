/**
 * Parent side of the Pine execution worker (`BE-23`).
 *
 * Three bounds, all enforced here rather than inside the script's own code:
 *   - **time**: the thread is terminated when the budget expires, so a script
 *     that ignores the interpreter's cooperative deadline still ends;
 *   - **memory**: the worker gets its own small heap, so an allocating script
 *     hits its own OOM instead of the API process's;
 *   - **concurrency**: a fixed number of workers may run at once and the queue
 *     is bounded, so N users cannot start N heavy runs and starve the box.
 *
 * The API process keeps its event loop free throughout: live alert evaluation
 * and webhook dispatch are no longer queued behind an editor run.
 */
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { BrokerOptions } from "../engine/broker";
import type { Bars } from "../engine/mtf";
import type { PineWorkerRequest, PineWorkerResponse } from "./runner.worker";

/** Simultaneous Pine runs. Two keeps a spare core for the API itself. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.PINE_MAX_CONCURRENT_RUNS ?? 2));
/** Runs allowed to wait. Beyond this the caller is told to try again. */
const MAX_QUEUED = Math.max(0, Number(process.env.PINE_MAX_QUEUED_RUNS ?? 8));
/** Heap ceiling for one run. A script that exceeds it kills only its thread. */
const MAX_HEAP_MB = Math.max(64, Number(process.env.PINE_WORKER_HEAP_MB ?? 512));
/** Grace after the interpreter's own deadline before the thread is terminated. */
const TERMINATE_GRACE_MS = 2_000;

export class PineBusyError extends Error {
  constructor() {
    super("too many Pine runs are already queued; try again in a moment");
  }
}

export interface PineRunRequest {
  source: string;
  bars: Bars;
  startIdx: number;
  endIdx: number;
  params?: Record<string, number | string | boolean>;
  broker: BrokerOptions | null;
  timeBudgetMs: number;
}

export type PineRunOutcome =
  | { kind: "ok"; run: Record<string, unknown> }
  | { kind: "script-error"; errors: { line: number; col: number; message: string }[] }
  | { kind: "timeout"; budgetMs: number }
  | { kind: "crash"; message: string };

let running = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return;
  }
  if (waiting.length >= MAX_QUEUED) throw new PineBusyError();
  await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
}

function release(): void {
  running -= 1;
  waiting.shift()?.();
}

/**
 * The compiled worker sits beside this file, so it is `.ts` under tsx and
 * `.js` under `dist/`. Workers inherit the parent's `execArgv`, which is what
 * carries the TypeScript loader in development and in the test runner.
 */
function workerFile(): string {
  return path.join(__dirname, `runner.worker${path.extname(__filename)}`);
}

export async function runPineInWorker(req: PineRunRequest): Promise<PineRunOutcome> {
  await acquire();
  try {
    return await new Promise<PineRunOutcome>((resolve) => {
      const payload: PineWorkerRequest = req;
      const worker = new Worker(workerFile(), {
        workerData: payload,
        resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, maxYoungGenerationSizeMb: 64 },
      });
      let settled = false;
      const finish = (outcome: PineRunOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        void worker.terminate();
        resolve(outcome);
      };
      const killer = setTimeout(
        () => finish({ kind: "timeout", budgetMs: req.timeBudgetMs }),
        req.timeBudgetMs + TERMINATE_GRACE_MS
      );
      // Do not hold the process open for a run nobody is waiting on.
      killer.unref?.();
      worker.on("message", (msg: PineWorkerResponse) => finish(msg));
      worker.on("error", (err) => finish({ kind: "crash", message: err.message }));
      worker.on("exit", (code) => {
        // An exit with no message means the thread died: terminated for the
        // wall clock, or killed by its own heap limit.
        if (code === 1) finish({ kind: "crash", message: "the script exhausted its memory limit" });
        else finish({ kind: "timeout", budgetMs: req.timeBudgetMs });
      });
    });
  } finally {
    release();
  }
}

/** Test seam: current pool occupancy. */
export function poolState(): { running: number; queued: number; max: number } {
  return { running, queued: waiting.length, max: MAX_CONCURRENT };
}
