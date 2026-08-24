/**
 * Request cancellation, de-duplication and stale-response suppression.
 *
 * Three defects the audit found in the chart's data path, all of which show up
 * as "the chart is slow" or "the chart showed the wrong coin for a moment":
 *
 *  * `FE-07` — no `AbortSignal` on roughly 55 endpoints. Switching symbol while
 *    a 2.5 MB candle request is in flight leaves that request running: it still
 *    consumes a connection, and the browser still parses the whole body.
 *
 *  * **Stale responses overwriting new state.** `load()` assigned
 *    `setCandles(data)` unconditionally, so if the first request finished after
 *    the second, the chart ended up showing the PREVIOUS symbol's candles under
 *    the new symbol's label — with no error and no way to tell.
 *
 *  * **Duplicated requests.** React strict mode double-invokes effects in
 *    development, and a fast double-click on a timeframe button issues the same
 *    request twice. At 2.5 MB each that is a real cost.
 *
 * The pieces here are deliberately tiny and pure so they can be tested without
 * a browser, a network or a chart.
 */

/**
 * A monotonically increasing token that identifies the LATEST request.
 *
 * A response is applied only if its token is still current. Comparing tokens
 * rather than comparing the request's parameters to the current state is what
 * makes this correct: a user who switches away and back lands on the same
 * parameters, and a parameter comparison would then wrongly accept the first,
 * slower response.
 */
export class LatestRequest {
  private current = 0;

  /** Claim the next token. Everything issued before this is now stale. */
  next(): number {
    this.current += 1;
    return this.current;
  }

  /** True when `token` is still the most recent claim. */
  isCurrent(token: number): boolean {
    return token === this.current;
  }

  /** Invalidate everything in flight without issuing a new request. */
  invalidate(): void {
    this.current += 1;
  }
}

/**
 * One in-flight request at a time, cancelled when a new one starts.
 *
 * `AbortController` is created per request and the previous one is aborted, so
 * a superseded fetch stops consuming a connection and stops being parsed.
 */
export class CancellableRequest {
  private controller: AbortController | null = null;

  /** Abort whatever is in flight and return a signal for the new request. */
  start(): AbortSignal {
    this.controller?.abort();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** Abort without starting anything — for a component unmounting. */
  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }

  get inFlight(): boolean {
    return this.controller !== null && !this.controller.signal.aborted;
  }
}

/** True when an error is a deliberate abort rather than a real failure. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  // Some environments surface a plain Error with the same name.
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Collapse concurrent identical requests into one shared promise.
 *
 * The key is supplied by the caller rather than derived, because "identical"
 * is a decision about intent: two requests for the same symbol and timeframe
 * are the same request, even if one asks for a slightly different bar count.
 *
 * The entry is dropped as soon as the promise settles, so this is a
 * coalescer and never a cache — serving a stale candle series from memory is
 * exactly the class of bug the rest of this module exists to prevent.
 */
export class RequestCoalescer {
  private inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = fn().finally(() => {
      // Only clear if this is still the registered promise: a later call that
      // replaced it must not be dropped by an earlier one settling.
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.inFlight.size;
  }
}

/**
 * The load states a chart may be in.
 *
 * `stale` and `error` exist so the UI never silently shows old data as if it
 * were current — which is what `FE-09`'s frozen websocket prices did.
 */
export type LoadState = "idle" | "loading" | "ready" | "stale" | "error";
