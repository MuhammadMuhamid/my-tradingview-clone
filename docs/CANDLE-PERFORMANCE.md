# Candle and chart loading

**Status:** current. Measurements are reproducible with
`cd platform/backend && npm run bench:candles`.

---

## 1. What was measured, and what was not

This matters more than the numbers, so it comes first.

**Measured.** Pure computation over a deterministic fixture, on this machine:

- the database row → `Candle` mapping that `platform/backend/src/repositories/candles.ts` performs
- JSON serialisation, and the wire size it produces
- `JSON.parse`, which the browser pays on its main thread before anything can
  be drawn
- the chart's candle → series transformation
- moving-average computation over the loaded window
- the contiguity check the live path now runs before evaluating

**Not measured, and not estimated:**

- **PostgreSQL query time.** No database is available in this workspace, so the
  `SELECT … ORDER BY open_time` cost is unknown. It is very likely a real part
  of cold-load latency and it is not reported here.
- **Browser paint, layout, long tasks, memory growth.** No browser harness was
  run against a live application, because the application needs the database.
- **Network latency, Binance backfill duration, websocket delivery time.**

Numbers for the second group would be invented. The benchmark prints them as
`unmeasured`, and no claim below rests on them.

---

## 2. Environment

| | |
|---|---|
| Node | v26.0.0 |
| Platform | darwin arm64, 10 cores |
| Samples | median of 15 runs per measurement |
| Fixture | deterministic seeded walk, no PRNG, identical between runs |
| Coverage | all **11** supported timeframes × 4 bar counts (500 / 2 000 / 10 000 / 50 000) |

Absolute timings vary between machines. The **ratio** between before and after
on the same machine is the meaningful figure, which is why both are reported.

---

## 3. The finding: the response repeated itself on every bar

The candle response sent one object per bar, and each object repeated `symbol`
and `interval` — values identical for the whole response — plus `closeTime`,
which is `openTime + interval − 1` by definition.

At the chart's **default of 10 000 bars**, that is a **2.4 MB** response for one
symbol at one timeframe, re-fetched on every symbol switch and every timeframe
switch.

---

## 4. Before and after

Medians across all eleven timeframes.

| bars | payload before | payload after | smaller | parse before | parse after | speed-up |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 121 KB | 34 KB | **72.3 %** | 0.40 ms | 0.26 ms | 1.53× |
| 2 000 | 489 KB | 135 KB | **72.3 %** | 1.62 ms | 1.07 ms | 1.51× |
| **10 000** (default) | **2 457 KB** | **684 KB** | **72.2 %** | 8.78 ms | 5.43 ms | 1.62× |
| 50 000 | 12 335 KB | 3 454 KB | **72.0 %** | 45.10 ms | 34.54 ms | 1.31× |

Client critical path — everything between the bytes arriving and a first paint:
parse, expand, transform to series, compute ten moving averages.

| bars | before | after | speed-up |
|---:|---:|---:|---:|
| 500 | 0.48 ms | 0.34 ms | 1.39× |
| 2 000 | 1.78 ms | 1.25 ms | 1.42× |
| **10 000** | **10.16 ms** | **6.42 ms** | **1.58×** |
| 50 000 | 49.62 ms | 39.90 ms | 1.24× |

The compact path's **expansion step is included** in the "after" column. Leaving
it out would flatter the new code.

**Payload reduction is 71.8 %–72.6 % across every one of the 44
timeframe/bar-count combinations.** That is the solid result: it is a property
of the encoding, not of this machine, and it is what a user on a slow connection
actually waits for.

The timing improvements are smaller and noisier, and at 50 000 bars individual
timeframes occasionally measure *slower* on a single run — allocation and GC
noise at that size. The medians above are stable; a single run at 50 000 bars
should not be read as precise.

---

## 5. What changed

### Compact wire format (`platform/backend/src/data/candleWire.ts`)

Opt-in via `?format=compact`. Positional arrays,
`[openTime, open, high, low, close, volume]`, with `symbol`, `interval` and
`stepMs` in the envelope and `closeTime` derived on the client.

Prices are rounded to 8 decimals — Binance's maximum tick precision. This is not
a loss: Binance sends prices as decimal **strings** with at most 8 places, and
`parseFloat` yields a double whose shortest representation sometimes carries
printing noise (`100.30000000000001` for a price that was `100.3`). Rounding
recovers the value that was sent. It is smaller *and* more faithful.

`quoteVolume` and `tradeCount` are deliberately absent — nothing on the chart
path reads them, and carrying them would give back most of the saving. Consumers
that need them use `api.candlesVerbose`, which is why the format is opt-in
rather than the only shape.

### Request cancellation, de-duplication and stale suppression (`FE-07`)

`platform/frontend/lib/requestGuard.ts`. Three separate defects:

- **No `AbortSignal` anywhere.** Switching symbol mid-request left a 2.4 MB
  fetch running: still holding a connection, still parsed in full.
- **Stale responses overwrote new state.** `setCandles(data)` was
  unconditional, so a slow *first* response landing after a fast second one
  painted the previous symbol's candles under the new symbol's label — silently,
  with no error. `LatestRequest` compares **tokens**, not parameters: a user who
  switches away and back lands on the same parameters, and a parameter
  comparison would then wrongly accept the first, slower response.
- **Duplicated requests.** React strict mode double-invokes effects in
  development, and a fast double-click on a timeframe issues the same request
  twice. `RequestCoalescer` shares one in-flight promise, and drops the entry as
  soon as it settles — it is a coalescer, never a cache, because serving a stale
  candle series from memory is the same class of bug.

### Backfill no longer re-fetches the whole window

The old path fetched the window, found it short, backfilled, then fetched the
**entire window again**. It now requests only the missing older range and
prepends it.

### Websocket reconnect and an honest feed state (`FE-09`)

`platform/frontend/components/CandleChart.tsx` had `onmessage` and nothing else — no `onerror`, no
`onclose`, no reconnect, no watchdog. When the socket dropped, or stayed open
while delivering nothing, the last price **froze on screen and kept being
displayed as if it were current**.

Now: capped exponential-backoff reconnect, and a 45-second silence watchdog —
because a socket can sit in `readyState === OPEN` and deliver nothing, which is
exactly what a connectivity check misses. The chart renders
`connecting… / reconnecting… / feed stalled — price is not current`. The `live`
state is deliberately **not** rendered: a green dot beside every chart is noise,
and the states worth interrupting for are the ones where the number on screen is
not current.

**Transport, dataset ownership and the boundary repaint (V1 repair, 2026-09-05).**
Three later findings against the live path were closed together:

- *Fenced stream host.* Every browser socket to Binance now goes through
  `platform/frontend/lib/marketStream.ts`: one origin list
  (`wss://data-stream.binance.vision`, Binance's market-data-only endpoint,
  first; `wss://stream.binance.com:9443` second), a 250 ms rotation to the next
  origin on a refused handshake, the same bounded ladder and silence watchdog
  for the kline feed, the watchlist's `miniTicker` stream and the ticket's
  `bookTicker`, and a state that names the cause (`stream refused — trying
  another host…`, `live stream unavailable — history still updates`). `live` is
  claimed only once a frame has arrived; a completed handshake is `connected —
  waiting for data`. The CSP `connect-src` lists both origins and
  `platform/frontend/tests/marketTransport.test.ts` fails if the two lists drift. The watchlist is
  seeded through `/api/symbols/tickers` (backend proxy of Binance's 24h ticker
  via the configured market-data host) so rows are never `—` for want of a
  socket.
- *Cross-dataset tick.* After a symbol change the previous window stays on
  screen while the next loads; the new feed's first frame used to be drawn onto
  it. `useCandleHistory` now reports what its candles *are* (`dataset`), the
  chart keys every decision on that, and `platform/frontend/lib/liveDataset.ts`'s `LiveTickGate`
  holds a tick for a dataset not yet on screen and applies it when that history
  lands. `platform/frontend/tests/candleDataset.test.ts` drives the exact sequence.
- *Boundary repaint.* On a full 10,000-bar window each bar close trimmed the
  state on the left, and the planners compared from index 0 and returned
  `replace` for candles, volume and every overlay, per pane, per boundary.
  `planCandleMutation` / `planSeriesMutation` / `planOhlcMutation` now share
  one time-aligned planner (`planAlignedMutation`) that recognises a left trim
  as the same tail; a trim it cannot honour is still a repaint.

---

## 6. Backend-side gaps, and where they were closed

- **`BE-14`** — `ensureCandles` accepted 98.5 % coverage with no contiguity
  check, so 31 absent bars in a 2 100-bar warmup (nearly eight hours) passed
  silently and every rolling indicator computed over a compressed timeline. The
  live path now refuses to evaluate on a gap. Cost of the check itself, measured:
  **1.75 ms at 10 000 bars**, 7.6 ms at 50 000 — cheap enough to run before every
  evaluation.
- **`BE-01`** — the multi-timeframe feed read used `to: barTime`, selecting the
  higher-timeframe bar that *opened* at or before the chart bar's open, while
  the backtest cuts off at the chart bar's *close*. A two-bar, ten-minute lag on
  the filters that gate entries. Fixed on the live side; the backtest was the
  correct side.

---

## 7. Still open

Each of these is real, and none is claimed as done.

- **Database query cost is unmeasured.** `getCandles` with only a `limit`
  performs `ORDER BY open_time DESC LIMIT n` inside a subquery and re-sorts
  ascending. Whether that is served from an index is unverified here.
- **`BE-23`** — `/api/pine/run` executes user scripts synchronously on the same
  event loop as the live alert runner, for up to 45 seconds. The documented
  limits *are* enforced, but a wall-clock budget is not a yield. Moving it to a
  worker thread is Phase 7.
- **`BE-24`** — the optimizer routes perform `readFileSync` on files their own
  comments call multi-gigabyte, and a `writeFileSync` inside a GET handler.
  Same event loop, same consequence. Phase 7.
- **Progressive history.** The chart still loads the whole selected window
  before drawing. Loading the visible range first and extending on pan is the
  larger structural win at 10 000+ bars, and it is not implemented.
- **Browser-side profiling.** Long tasks, render churn and memory growth over a
  session are unmeasured, and will stay so until the application can be run
  against a database.
