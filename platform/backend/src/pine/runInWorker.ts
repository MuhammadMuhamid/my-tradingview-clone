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

/** Extensions that mean this module is running from TypeScript source. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Where the worker thread starts.
 *
 * Compiled, that is `runner.worker.js` beside this file and no loader is
 * involved. From source it is a plain-CommonJS bootstrap that installs the
 * TypeScript require hook itself, because a worker thread does **not**
 * reliably inherit the parent's: on Node 22 the hooks tsx registers through
 * `module.register()` do not apply inside a worker, so a `.ts` entry was read
 * by Node's own type stripping and died on its first relative import. The
 * bootstrap makes the entry independent of whatever the parent was started
 * with, which is the property `pineWorkerEntry` exists to let a test pin.
 */
export function pineWorkerEntry(): string {
  const ext = path.extname(__filename);
  if (SOURCE_EXTENSIONS.has(ext)) return path.join(__dirname, "runner.worker.bootstrap.cjs");
  return path.join(__dirname, `runner.worker${ext}`);
}

/**
 * Node's own loader and worker-startup failures, which surface on the worker's
 * `error` event before the script has run at all. The interpreter's own
 * failures never reach that event — `executePine` catches them and answers with
 * a message — so an `error` here is an infrastructure fault, not a script one.
 */
const STARTUP_ERROR_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_WORKER_UNSUPPORTED_EXTENSION",
  "ERR_WORKER_INIT_FAILED",
  "ERR_WORKER_PATH",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_REQUIRE_ESM",
  "ERR_INVALID_MODULE_SPECIFIER",
  "ERR_UNSUPPORTED_ESM_URL_SCHEME",
]);

/**
 * Turn a worker failure into something an operator can act on without leaking
 * anything. The caller's Pine source, the request and the environment are never
 * touched; only the error's own class and code reach the response, and the full
 * diagnostic — paths and stack, no script text — goes to the server log.
 */
function crashOutcome(err: Error, entry: string): PineRunOutcome {
  const code = (err as NodeJS.ErrnoException).code;
  const label = code ?? err.name ?? "unknown error";
  console.error(
    `[pine] worker thread failed to start or died outside the interpreter: ` +
      `entry=${entry} code=${label} message=${err.message}`,
    err.stack
  );
  if (code !== undefined && STARTUP_ERROR_CODES.has(code)) {
    return {
      kind: "crash",
      message:
        `the Pine execution worker could not be started (${label}); ` +
        "this is a server fault, not a fault in the script",
    };
  }
  return {
    kind: "crash",
    message: `the Pine execution worker failed (${label}); the script did not complete`,
  };
}

export async function runPineInWorker(req: PineRunRequest): Promise<PineRunOutcome> {
  await acquire();
  try {
    return await new Promise<PineRunOutcome>((resolve) => {
      const payload: PineWorkerRequest = req;
      const entry = pineWorkerEntry();
      const worker = new Worker(entry, {
        workerData: payload,
        resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB, maxYoungGenerationSizeMb: 64 },
      });
      let settled = false;
      let failed = false;
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
      worker.on("error", (err) => {
        failed = true;
        finish(crashOutcome(err, entry));
      });
      worker.on("exit", (code) => {
        // An exit with no message means the thread died: terminated for the
        // wall clock, or killed by its own heap limit. A thread that already
        // reported an error exits here too, and has been answered already.
        if (failed) finish({ kind: "crash", message: "the Pine execution worker failed" });
        else if (code === 1) finish({ kind: "crash", message: "the script exhausted its memory limit" });
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
