/**
 * One process-wide pace for outbound requests to a single provider endpoint.
 *
 * The kline pager used to be its own rate limiter: one page at a time and a
 * fixed 150 ms sleep between pages. That kept Binance comfortable, and it made
 * every 10,000-bar chart load ten round trips plus 1.35 s of sleeping in a row —
 * ~3.4 s before the first byte, cold or warm (B-08). Pages of one window are
 * independent, so they can be in flight together; what must stay bounded is the
 * PROCESS's rate against the provider, not one caller's.
 *
 * Two bounds, both process-wide:
 *
 *   - `maxConcurrent` requests in flight at once;
 *   - a token bucket of `burst` requests refilled at `ratePerSecond`, so a
 *     chart load can spend a burst at once while a long backfill — or several
 *     at once — settles to the sustained rate.
 *
 * A provider that answers 429/418 has said it is over budget for the whole
 * address, not for one request, so `pauseUntil` holds every caller, not only the
 * one that was refused.
 */
export interface RequestPacerOptions {
  maxConcurrent: number;
  ratePerSecond: number;
  burst: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RequestPacer {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RequestPacerOptions) {
    if (!(options.maxConcurrent >= 1) || !(options.ratePerSecond > 0) || !(options.burst >= 1)) {
      throw new Error("request pacer bounds must be positive");
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tokens = options.burst;
    this.refilledAt = this.now();
  }

  /** Requests currently in flight — exposed for tests and diagnostics. */
  get inFlight(): number { return this.active; }

  /** The epoch ms every caller is held until (0 when never paused). */
  get pausedUntilMs(): number { return this.pausedUntil; }

  /** Hold every caller until `at` (epoch ms); never shortens an existing pause. */
  pauseUntil(at: number): void {
    if (at > this.pausedUntil) this.pausedUntil = at;
  }

  /**
   * Run `operation` inside the bounds. A `signal` that aborts while the caller
   * is still queued means the request is never sent and spends no budget.
   */
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireSlot();
    try {
      signal?.throwIfAborted();
      await this.acquireToken(signal);
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.active < this.options.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    // The releasing caller hands its slot to the next waiter synchronously, so
    // no newcomer can take it in between and waiters are served in order.
    return new Promise((resolve) => this.waiting.push(() => { this.active += 1; resolve(); }));
  }

  private async acquireToken(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.now();
      if (this.pausedUntil > now) { await this.sleep(this.pausedUntil - now); continue; }
      const elapsed = Math.max(0, now - this.refilledAt);
      this.tokens = Math.min(this.options.burst, this.tokens + (elapsed * this.options.ratePerSecond) / 1000);
      this.refilledAt = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await this.sleep(Math.ceil(((1 - this.tokens) * 1000) / this.options.ratePerSecond));
    }
  }
}
