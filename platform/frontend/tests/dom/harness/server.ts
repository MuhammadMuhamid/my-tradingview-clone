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
import type { ServerLayout, ServerWatchlist } from "@/lib/api";
import type { SymbolInfo } from "@/lib/types";
import {
  CATALOGUE, legacyTickers, marketTickers, providerSymbol, providerSymbolOf, searchResponse,
  streamConfig, symbolInfo,
} from "./market";

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

  /*
   * ── TVP8 IO-A2-COV: the canonical instrument the product stands on ────────
   *
   * See `./market.ts`. The symbols table, the two search routes, both ticker
   * routes, the canonical candle route, the provider stream config and a
   * watchlist that PERSISTS are all served from here now, in the shapes
   * `lib/api` describes, so a DOM test can put a pane on an `instrument:v1:…`
   * identity and reach the paths that only exist for one.
   */
  /** Whether `/api/market/v1/stream/:id` answers. The standalone QA fixture turns it off. */
  streamConfigs = true;
  /** The local symbols table — the catalogue's tracked rows, plus what `POST /api/symbols` adds. */
  private readonly tracked = new Map<string, SymbolInfo>();
  /** Watchlists, persisted for the life of a test the way the database persists them for a user. */
  readonly watchlists = new Map<string, ServerWatchlist>();
  private watchlistSeq = 0;
  /**
   * Saved layouts, persisted for the life of a test.
   *
   * TVP8 F-07: `/api/layouts` answered `[]` from the static table and had
   * nothing to write to, so no DOM test could reach the menu's recents list or
   * its `Open layout…` dialog — the two surfaces that finding is about. This is
   * the same shape `watchlistRequest` implements, for the same reason.
   */
  readonly layouts = new Map<string, ServerLayout>();
  private layoutSeq = 0;

  /**
   * Extra routes a single test needs, checked before the built-in table.
   *
   * A handler may return a promise, so a test can decide when — and in what
   * order — two in-flight requests answer.
   */
  readonly routes = new Map<string, (body: unknown, url: URL) => unknown>();

  private readonly holds: { match: HoldMatch; held: Held }[] = [];

  constructor() {
    for (const item of CATALOGUE) if (item.tracked) this.tracked.set(providerSymbol(item), symbolInfo(item));
  }

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
    this.tracked.clear();
    for (const item of CATALOGUE) if (item.tracked) this.tracked.set(providerSymbol(item), symbolInfo(item));
    this.watchlists.clear();
    this.watchlistSeq = 0;
    this.layouts.clear();
    this.layoutSeq = 0;
    this.streamConfigs = true;
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


  /**
   * Bars for one provider symbol, in whichever wire format was asked for.
   *
   * Shared by the legacy `/api/symbols/:symbol/candles` route and the
   * canonical `/api/market/v1/candles/:id` route, because the backend serves
   * both from the same store after resolving the id to its listing — a fixture
   * that folded resolutions on one route and not the other would let a 45m
   * canonical chart pass here and be wrong in the product.
   */
  private candlesResponse(symbol: string, url: URL): Response {
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

  /**
   * A watchlist that already exists when the page loads — a returning user.
   *
   * Most tests that need a populated list want THIS, not the first-run seed:
   * the seed is one product behaviour with its own test, and a test of the
   * ticker poll or of a row's click should not depend on it.
   */
  seedWatchlist(symbols: readonly string[], name = "Main Watchlist"): ServerWatchlist {
    const row: ServerWatchlist = {
      id: `wl-${++this.watchlistSeq}`, name, symbols: [...symbols],
      position: this.watchlists.size, updatedAt: new Date().toISOString(),
    };
    this.watchlists.set(row.id, row);
    return row;
  }

  /**
   * Layouts that already exist when the page loads — a returning user with a
   * library to switch between (TVP8 F-07).
   */
  seedLayouts(rows: readonly Partial<ServerLayout>[]): ServerLayout[] {
    return rows.map((row) => {
      const full = this.layoutRow(row);
      this.layouts.set(full.id, full);
      return full;
    });
  }

  /** A `ServerLayout` with every field the client reads, defaults for the rest. */
  private layoutRow(over: Partial<ServerLayout>): ServerLayout {
    const now = new Date().toISOString();
    return {
      id: over.id ?? `ly-${++this.layoutSeq}`,
      name: over.name ?? "Layout",
      symbol: over.symbol ?? "SOLUSDT",
      timeframe: over.timeframe ?? "15m",
      bars: over.bars ?? 300,
      strategyKey: over.strategyKey ?? "sr_trend",
      params: over.params ?? {},
      properties: over.properties ?? {
        initialCapital: 10_000, qtyCash: 1_000, commissionPct: 0.1, slippageTicks: 0,
      },
      movingAverages: over.movingAverages ?? [],
      ...(over.workspace === undefined ? {} : { workspace: over.workspace }),
      createdAt: over.createdAt ?? now,
      updatedAt: over.updatedAt ?? now,
    } as ServerLayout;
  }

  /** `/api/layouts` — list, create, rename/edit, delete, and the sync no-op. */
  private layoutRequest(method: string, path: string, body: unknown): Response | undefined {
    if (path === "/api/layouts/sync-deployments") return json(200, { synced: [], count: 0 });
    if (path !== "/api/layouts" && !path.startsWith("/api/layouts/")) return undefined;
    const id = path.slice("/api/layouts".length).replace(/^\//, "");
    const patch = (body ?? {}) as Partial<ServerLayout>;
    if (method === "GET" && !id) {
      return json(200, [...this.layouts.values()]);
    }
    if (method === "GET" && id) {
      const row = this.layouts.get(id);
      return row ? json(200, row) : json(404, { error: `no layout ${id}` });
    }
    if (method === "POST" && !id) {
      const row = this.layoutRow(patch);
      this.layouts.set(row.id, row);
      return json(200, row);
    }
    if (method === "PATCH" && id) {
      const row = this.layouts.get(id);
      if (!row) return json(404, { error: `no layout ${id}` });
      const next = { ...row, ...patch, id, updatedAt: new Date().toISOString() };
      this.layouts.set(id, next);
      return json(200, next);
    }
    if (method === "DELETE" && id) { this.layouts.delete(id); return json(200, {}); }
    return undefined;
  }

  /**
   * `/api/watchlists` — create, list, rename, edit, delete.
   *
   * The QA fixture (`qa/chart-fixture.ts`) carried this in its own process
   * because the shared harness answered `GET` with `[]` and had nothing to
   * `POST` to: the panel rendered its empty state and every way out of it —
   * the seed chips, typing a symbol — posted into a 404 and silently did
   * nothing. In a DOM test that meant the watchlist NEVER held a symbol, so
   * its ticker poll never started, so IO-A7's end-to-end test could not fail.
   * The same rows, the same `ServerWatchlist` shape, now served here.
   */
  private watchlistRequest(method: string, path: string, body: unknown): Response | undefined {
    if (path !== "/api/watchlists" && !path.startsWith("/api/watchlists/")) return undefined;
    const id = path.slice("/api/watchlists".length).replace(/^\//, "");
    const patch = (body ?? {}) as Partial<ServerWatchlist>;
    if (method === "GET" && !id) {
      return json(200, [...this.watchlists.values()].sort((a, b) => a.position - b.position));
    }
    if (method === "POST" && !id) {
      const existing = [...this.watchlists.values()].find((w) => w.name === patch.name);
      const row: ServerWatchlist = {
        id: existing?.id ?? `wl-${++this.watchlistSeq}`,
        name: patch.name ?? "Watchlist",
        symbols: patch.symbols ?? existing?.symbols ?? [],
        position: patch.position ?? existing?.position ?? this.watchlists.size,
        updatedAt: new Date().toISOString(),
      };
      this.watchlists.set(row.id, row);
      return json(200, row);
    }
    if (method === "PATCH" && id) {
      const row = this.watchlists.get(id);
      if (!row) return json(404, { error: `no watchlist ${id}` });
      const next: ServerWatchlist = {
        ...row,
        name: patch.name ?? row.name,
        symbols: patch.symbols ?? row.symbols,
        position: patch.position ?? row.position,
        updatedAt: new Date().toISOString(),
      };
      this.watchlists.set(id, next);
      return json(200, next);
    }
    if (method === "DELETE" && id) { this.watchlists.delete(id); return json(200, {}); }
    return undefined;
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
    if (custom) {
      const response = await custom(body, url);
      return response instanceof Response ? response : json(200, response);
    }

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
    if (candleMatch) return this.candlesResponse(decodeURIComponent(candleMatch[1]!).toUpperCase(), url);

    const canonicalCandles = /^\/api\/market\/v1\/candles\/(.+)$/.exec(path);
    if (canonicalCandles) {
      const id = decodeURIComponent(canonicalCandles[1]!);
      const symbol = providerSymbolOf(id);
      if (symbol === null) return json(404, { error: `unknown instrument: ${id}` });
      return this.candlesResponse(symbol, url);
    }

    const streamMatch = /^\/api\/market\/v1\/stream\/(.+)$/.exec(path);
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1]!);
      const kind = url.searchParams.get("kind") === "ticker" ? "ticker" : "candle";
      const config = this.streamConfigs ? streamConfig(id, kind, url.searchParams.get("interval") ?? "1m") : null;
      return config ? json(200, config) : json(404, { error: `no stream for ${id}` });
    }

    if (path === "/api/market/v1/search") return json(200, searchResponse(url));
    if (path === "/api/symbols/search") return json(200, searchResponse(url, true));
    if (path === "/api/market/v1/tickers") {
      const ids = (url.searchParams.get("instruments") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      return json(200, marketTickers(ids));
    }
    if (path === "/api/symbols/tickers") {
      const symbols = (url.searchParams.get("symbols") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      return json(200, legacyTickers(symbols));
    }
    if (path === "/api/symbols") {
      if (method === "POST") {
        const wanted = (body ?? {}) as { symbol?: string; baseAsset?: string; quoteAsset?: string };
        const symbol = String(wanted.symbol ?? "").toUpperCase();
        if (!symbol) return json(400, { error: "symbol is required" });
        const known = CATALOGUE.find((i) => providerSymbol(i) === symbol);
        const row: SymbolInfo = known ? symbolInfo(known) : {
          symbol, canonicalId: null, baseAsset: String(wanted.baseAsset ?? symbol), quoteAsset: String(wanted.quoteAsset ?? ""),
          priceTick: null, qtyStep: null, minNotional: null, isActive: true,
        };
        this.tracked.set(symbol, row);
        return json(200, row);
      }
      return json(200, [...this.tracked.values()]);
    }

    const watchlist = this.watchlistRequest(method, path, body);
    if (watchlist !== undefined) return watchlist;

    const layout = this.layoutRequest(method, path, body);
    if (layout !== undefined) return layout;

    const table: Record<string, unknown> = {
      // The history repair path. `chartShell.test.tsx` exercises a stale tail
      // deliberately; everywhere else it must simply not 404.
      "/api/data/backfill": { fetched: 0 },
      "/api/strategies": [],
      "/api/pine": [],
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
      /*
       * TVP8: this said `{ halted: false, feeds: [] }`, and `feeds` in
       * `lib/api.ts` is `{ worst, rows }`. No DOM test mounts Operations, so
       * it was harmless here and lethal in the standalone QA fixture, which
       * copied it: the whole route crashed into its error boundary reading
       * `status.feeds.rows.length`.
       *
       * A fixture that answers with a shape production never sends is worse
       * than one that 404s — the 404 is obviously a fixture, and the wrong
       * shape looks like a product bug.
       */
      "/api/ops/status": {
        mode: "DISABLED",
        feeds: { worst: "live", rows: [] },
      },
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
