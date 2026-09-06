/**
 * The backend, as far as the browser can tell.
 *
 * ── Why a fixture origin rather than the real server ───────────────────────
 *
 * These are FRONTEND tests: what they are looking for is a component wired to
 * the wrong argument, an effect that saves before it has restored, a handler
 * that reads the pointer's price instead of the drawing's. Booting Postgres to
 * find those would make the fastest half of the suite the slowest, and would
 * make every frontend failure ambiguous between the two sides.
 *
 * So the origin is faked and the CONTRACT is not. Chart state is the part that
 * matters, and it is implemented here exactly as
 * `backend/src/repositories/chartState.ts` implements it — version counter,
 * `baseVersion` refusal with the current state as the 409 body, an omitted
 * half left alone, and `pineWritten` / `nativeWritten` set by what a write
 * carried rather than by what it contained. Those five rules are the ones the
 * frontend's data-loss defects lived in, so they are the ones a fake must not
 * simplify. `runtime/mcp` proves the same sequences against the real backend.
 *
 * ── What it can be told to do ──────────────────────────────────────────────
 *
 * Fail (`server.offline`), stall a specific route until released
 * (`server.hold`), let another writer land between two requests
 * (`server.interpose`), and record every request (`server.calls`). A race is
 * not reproducible by hoping two promises settle in an order; it is
 * reproducible by holding the first response until the second has landed, and
 * by moving the stored row under a client that is mid-conversation.
 */

import {
  foldBars, parseResolution, sourceBarsNeeded, type FoldableBar,
} from "@/lib/resolution";

export interface StoredDrawingRow {
  venue: string;
  symbol: string;
  drawings: unknown[];
  version: number;
  updatedAt: string;
}

export interface StoredPaneRow {
  scope: string;
  pine: unknown[];
  native: unknown[];
  version: number;
  updatedAt: string;
  pineWritten: boolean;
  nativeWritten: boolean;
}

/** `[openTime, open, high, low, close, volume]` — the wire's own bar. */
export type CompactBar = [number, number, number, number, number, number];

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

interface Held {
  release: () => void;
  released: Promise<void>;
}

/** What a hold applies to: a path fragment, or the whole request. */
export type HoldMatch =
  | string
  | ((request: { method: string; path: string; body: unknown }) => boolean);

const NEVER = new Date(0).toISOString();

/** Body of a `fetch` init, parsed back into whatever the caller sent. */
function parseBody(init: RequestInit | undefined): unknown {
  if (!init || init.body == null) return undefined;
  if (typeof init.body !== "string") return init.body;
  try { return JSON.parse(init.body); } catch { return init.body; }
}

export class FixtureServer {
  readonly drawings = new Map<string, StoredDrawingRow>();
  readonly panes = new Map<string, StoredPaneRow>();
  readonly calls: RecordedCall[] = [];

  /** Every request is refused, the way an unreachable server refuses one. */
  offline = false;

  /**
   * Extra routes a single test needs, checked before the built-in table.
   *
   * A handler may return a promise, so a test can decide when — and in what
   * order — two in-flight requests answer.
   */
  readonly routes = new Map<string, (body: unknown, url: URL) => unknown>();

  private readonly holds: { match: HoldMatch; held: Held }[] = [];

  /**
   * Another device, landing between this client's requests.
   *
   * A race between two writers on one row cannot be staged with `hold` alone:
   * `hold` stalls a request, and what is needed here is for the STORED state to
   * move while a request is in flight. The interposer runs immediately before
   * each request is dispatched, with the request in hand, so a test can decide
   * — per attempt — that somebody else got there first. The refusals the client
   * then sees are the fixture's real version rule refusing a real stale write,
   * not a canned 409.
   */
  private interposer: ((request: RecordedCall) => void) | null = null;

  /** Run `fn` just before each request is answered; `null` clears it. */
  interpose(fn: ((request: RecordedCall) => void) | null): void {
    this.interposer = fn;
  }

  /**
   * Bars, per `SYMBOL|interval`, plus a fallback used for any key not set.
   *
   * Served in whichever of the two wire formats the request asked for, exactly
   * as `backend/src/data/candleWire.ts` serves them — `closeTime` derived from
   * `stepMs` rather than transmitted. A fixture that invented a third shape
   * would let a chart pass here and be blank in the product.
   */
  private readonly candlesByKey = new Map<string, CompactBar[]>();
  private fallbackCandles: CompactBar[] = [];

  setCandles(symbol: string, interval: string, bars: CompactBar[]): void {
    this.candlesByKey.set(`${symbol.toUpperCase()}|${interval}`, bars);
  }

  /** Bars served for any symbol/interval a test has not named explicitly. */
  setDefaultCandles(bars: CompactBar[]): void {
    this.fallbackCandles = bars;
  }

  candlesFor(symbol: string, interval: string): CompactBar[] {
    return this.candlesByKey.get(`${symbol.toUpperCase()}|${interval}`) ?? this.fallbackCandles;
  }

  /**
   * Stall matching requests until the returned function is called.
   *
   * The whole point of a race test is to CHOOSE the order two answers settle
   * in. Hoping that a slow response lands second is not a test of the stale
   * response guard; holding the first one open until the second has landed is.
   *
   * `match` is a path fragment or a predicate over the request, because two
   * Pine runs for two different symbols are the same path and differ only in
   * their bodies.
   */
  hold(match: HoldMatch): () => void {
    let release = (): void => {};
    const released = new Promise<void>((resolve) => { release = () => resolve(); });
    const entry = { match, held: { release, released } };
    this.holds.push(entry);
    return () => {
      entry.held.release();
      const index = this.holds.indexOf(entry);
      if (index >= 0) this.holds.splice(index, 1);
    };
  }

  /** Requests recorded so far whose path contains `fragment`. */
  callsTo(fragment: string): RecordedCall[] {
    return this.calls.filter((c) => c.path.includes(fragment));
  }

  reset(): void {
    this.drawings.clear();
    this.panes.clear();
    this.routes.clear();
    for (const entry of this.holds) entry.held.release();
    this.holds.length = 0;
    this.calls.length = 0;
    this.offline = false;
    this.interposer = null;
    this.candlesByKey.clear();
    this.fallbackCandles = [];
  }

  // ── the chart-state contract ─────────────────────────────────────────────

  getDrawings(symbol: string): StoredDrawingRow {
    const key = symbol.toUpperCase();
    return this.drawings.get(key) ?? {
      venue: "BINANCE", symbol: key, drawings: [], version: 0, updatedAt: NEVER,
    };
  }

  /** Seed a row as if another device had written it. */
  seedDrawings(symbol: string, drawings: unknown[], version = 1): void {
    this.drawings.set(symbol.toUpperCase(), {
      venue: "BINANCE", symbol: symbol.toUpperCase(), drawings,
      version, updatedAt: new Date().toISOString(),
    });
  }

  seedPane(scope: string, row: Partial<StoredPaneRow>): void {
    const current = this.getPane(scope);
    this.panes.set(scope, {
      ...current,
      ...row,
      scope,
      updatedAt: new Date().toISOString(),
    });
  }

  getPane(scope: string): StoredPaneRow {
    return this.panes.get(scope) ?? {
      scope, pine: [], native: [], version: 0, updatedAt: NEVER,
      pineWritten: false, nativeWritten: false,
    };
  }

  private putDrawings(
    symbol: string, body: { drawings?: unknown; baseVersion?: unknown }
  ): { status: number; payload: StoredDrawingRow } {
    const key = symbol.toUpperCase();
    const drawings = Array.isArray(body.drawings) ? body.drawings : [];
    const base = Number(body.baseVersion);
    const baseVersion = Number.isFinite(base) && base > 0 ? Math.floor(base) : 0;
    const current = this.drawings.get(key);

    if (baseVersion <= 0) {
      // First write: refused if a row already exists, because this writer made
      // its decision in ignorance of whoever created it.
      if (current) return { status: 409, payload: current };
      const row: StoredDrawingRow = {
        venue: "BINANCE", symbol: key, drawings,
        version: 1, updatedAt: new Date().toISOString(),
      };
      this.drawings.set(key, row);
      return { status: 200, payload: row };
    }
    if (!current || current.version !== baseVersion) {
      return { status: 409, payload: this.getDrawings(key) };
    }
    const row: StoredDrawingRow = {
      ...current, drawings, version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.drawings.set(key, row);
    return { status: 200, payload: row };
  }

  private putPane(
    scope: string, body: { pine?: unknown; native?: unknown; baseVersion?: unknown }
  ): { status: number; payload: StoredPaneRow } {
    const pine = body.pine === undefined ? undefined : (body.pine as unknown[]);
    const native = body.native === undefined ? undefined : (body.native as unknown[]);
    const base = Number(body.baseVersion);
    const baseVersion = Number.isFinite(base) && base > 0 ? Math.floor(base) : 0;
    const current = this.panes.get(scope);

    if (baseVersion <= 0) {
      if (current) return { status: 409, payload: current };
      const row: StoredPaneRow = {
        scope,
        pine: pine ?? [],
        native: native ?? [],
        version: 1,
        updatedAt: new Date().toISOString(),
        // Written means "this write carried the half", not "the half has rows".
        pineWritten: pine !== undefined,
        nativeWritten: native !== undefined,
      };
      this.panes.set(scope, row);
      return { status: 200, payload: row };
    }
    if (!current || current.version !== baseVersion) {
      return { status: 409, payload: this.getPane(scope) };
    }
    const row: StoredPaneRow = {
      scope,
      // An omitted half is left exactly as stored — the SQL `COALESCE`.
      pine: pine ?? current.pine,
      native: native ?? current.native,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      pineWritten: current.pineWritten || pine !== undefined,
      nativeWritten: current.nativeWritten || native !== undefined,
    };
    this.panes.set(scope, row);
    return { status: 200, payload: row };
  }

  // ── the fetch this origin answers ────────────────────────────────────────

  async handle(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input, "http://127.0.0.1");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parseBody(init);
    const path = url.pathname;
    this.calls.push({ method, path: `${path}${url.search}`, body });

    const request = { method, path, body };
    for (const entry of [...this.holds]) {
      const hit = typeof entry.match === "string"
        ? path.includes(entry.match)
        : entry.match(request);
      if (hit) await Promise.race([entry.held.released, aborted(init?.signal)]);
    }
    /*
     * An abort is a rejection, the way `fetch` makes it one.
     *
     * The product cancels a request whenever it supersedes itself, and
     * `isAbortError` is a branch in three loaders. A fixture that resolved an
     * aborted request anyway would leave that branch untested and would make a
     * cancelled load look like a slow one.
     */
    if (init?.signal?.aborted) throw abortError();
    if (this.offline) throw new TypeError("fetch failed");

    // The other writer gets its turn here, after any hold has been released
    // and before this request is answered — which is exactly the window a
    // second device's write lands in.
    this.interposer?.({ method, path: `${path}${url.search}`, body });

    const custom = this.routes.get(`${method} ${path}`) ?? this.routes.get(path);
    if (custom) return json(200, await custom(body, url));

    const drawingMatch = /^\/api\/chart-state\/drawings\/(.+)$/.exec(path);
    if (drawingMatch) {
      const symbol = decodeURIComponent(drawingMatch[1]!);
      if (method === "GET") return json(200, this.getDrawings(symbol));
      const result = this.putDrawings(symbol, (body ?? {}) as never);
      return json(result.status, result.payload);
    }

    const paneMatch = /^\/api\/chart-state\/panes\/(.+)$/.exec(path);
    if (paneMatch) {
      const scope = decodeURIComponent(paneMatch[1]!);
      if (method === "GET") return json(200, this.getPane(scope));
      const result = this.putPane(scope, (body ?? {}) as never);
      return json(result.status, result.payload);
    }

    if (path === "/api/chart-state/panes") return json(200, [...this.panes.values()]);

    const candleMatch = /^\/api\/symbols\/([^/]+)\/candles$/.exec(path);
    if (candleMatch) {
      const symbol = decodeURIComponent(candleMatch[1]!).toUpperCase();
      const requested = url.searchParams.get("interval") ?? "15m";
      /*
       * The fixture serves resolutions the same way the backend does.
       *
       * A derived resolution is not stored on either side: the server reads the
       * SOURCE bars and folds them with `lib/resolution`, and so does this. A
       * fixture that simply handed back a stored `45m` array would prove that
       * the chart can render an array — it would prove nothing about whether a
       * 45-minute bar on this product is three real fifteen-minute bars.
       */
      const plan = parseResolution(requested);
      if (plan === null) return json(400, { error: `invalid interval: ${requested}` });
      const stepMs = plan.ms;
      const interval = plan.id;
      const limit = Number(url.searchParams.get("limit") ?? "1000");
      const all = this.candlesFor(symbol, plan.source);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      let source = all;
      if (from !== null || to !== null) {
        const lo = from === null ? -Infinity : Number(from);
        const hi = to === null ? Infinity : Number(to);
        source = all.filter(([t]) => t >= lo && t <= hi);
      }
      const sourceLimit = Number.isFinite(limit) ? sourceBarsNeeded(plan, limit) : Infinity;
      // Newest-first truncation, then chronological — the backend's own rule.
      if (source.length > sourceLimit) source = source.slice(-sourceLimit);

      let bars: CompactBar[];
      if (plan.factor === 1) {
        bars = source;
      } else {
        const asBars: FoldableBar[] = source.map(([t, o, h, l, c, v]) => ({
          symbol, interval: plan.source, openTime: t, open: o, high: h, low: l,
          close: c, volume: v,
          closeTime: t + (plan.ms / plan.factor) - 1,
        }));
        const folded = foldBars(asBars, plan);
        // The oldest bucket is dropped when the read began inside it, exactly as
        // `readResolvedCandles` does — a bar built from a fraction of its span
        // must not be drawn at full width beside whole ones.
        if (folded.length > 0 && asBars.length > 0
          && asBars[0]!.openTime !== folded[0]!.openTime) folded.shift();
        bars = folded.map((b): CompactBar => [b.openTime, b.open, b.high, b.low, b.close, b.volume]);
      }
      if (Number.isFinite(limit) && bars.length > limit) bars = bars.slice(-limit);
      if (url.searchParams.get("format") === "compact") {
        return json(200, {
          format: "compact-v1", symbol, interval, stepMs, count: bars.length, bars,
        });
      }
      return json(200, bars.map(([openTime, open, high, low, close, volume]) => ({
        symbol, interval, openTime, open, high, low, close, volume,
        closeTime: openTime + stepMs - 1,
      })));
    }

    const table: Record<string, unknown> = {
      "/api/symbols": [
        { symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", isActive: true },
        { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT", isActive: true },
      ],
      "/api/symbols/tickers": [],
      // The history repair path. `chartShell.test.tsx` exercises a stale tail
      // deliberately; everywhere else it must simply not 404.
      "/api/data/backfill": { fetched: 0 },
      "/api/strategies": [],
      "/api/pine": [],
      "/api/layouts": [],
      "/api/watchlists": [],
      "/api/ma-alerts": [],
      "/api/deployments": [],
      "/api/backtests": [],
      "/api/trading-overlays": { historical: [], current: [], truncated: false },
      /*
       * The full `ManualTradingState` shape, not a convenient subset.
       *
       * The chart page reads `manualState?.positions.filter(...)`, so a fixture
       * that omitted a list the real endpoint always sends would fail the page
       * for a reason the product does not have.
       */
      "/api/manual-trading/state": {
        enabled: false, mainnetEnabled: false, dryRun: true, mixed: false,
        accounts: [], orders: [], positions: [],
        protection: {
          type: "bot-managed", exchangeResting: false,
          note: "the execution bot owns protection; the platform never rests an order",
        },
      },
      "/api/ops/status": { halted: false, feeds: [] },
      "/api/push/vapid": { publicKey: "", devices: 0 },
    };
    if (path in table) return json(200, table[path]);

    // Anything unmapped is a 404 with a body that names the path, so a test
    // that trips one is told which endpoint it forgot rather than seeing an
    // unexplained empty render.
    return json(404, { error: `fixture server has no route for ${method} ${path}` });
  }
}

/** Settles when the signal aborts; never settles when there is none. */
function aborted(signal: AbortSignal | null | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The single instance every test in a file shares; reset between them. */
export const server = new FixtureServer();

/** Point global `fetch` at the fixture. Returns the restore function. */
export function installFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(String(input), init)) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
