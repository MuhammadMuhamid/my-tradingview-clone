# The component-behaviour layer

`tests/*.test.ts` is 778 assertions over pure functions and over source text.
That layer is fast, honest about what it is, and blind to one whole class of
defect: a hook wired to the wrong argument, a handler that reads the pointer's
price instead of the drawing's, an effect that saves before it has restored, a
keyboard listener that fires while the user is typing. Each of those is correct
in every unit it is made of and wrong once the units are connected, and the
previous campaign shipped several of them.

This directory is the smallest layer that can see them: a real DOM, the real
components, the real hooks, the real stores, and a fixture origin that
implements the server's contract exactly.

## Running it

```bash
npm test           # both layers
npm run test:unit  # the pure/source layer only
npm run test:dom   # this one
```

## What is real and what is not

**Real.** Every component, hook, store and module under `app/`, `components/`
and `lib/`. `lightweight-charts` runs unmodified, so `priceToCoordinate` and
`coordinateToLogical` do genuine arithmetic and a drag at y=300 lands on the
price that is actually at y=300 — which is how these tests can tell a drawing's
own level apart from the pointer's.

**Not real, and only these:**

| Faked | Why | Where |
|---|---|---|
| A 2D canvas context | jsdom has none, and a chart dereferences one immediately | `harness/register.ts` |
| `PointerEvent`, `matchMedia` | jsdom implements neither | `harness/register.ts` |
| `ResizeObserver` | jsdom has none. This one is REAL in behaviour: `observe` records the target and delivers its current box once, and `resize(el, box)` re-reports an element and delivers entries to every observer watching it — inside `act`, so the product's reaction is committed before the test continues. It throws if nothing observes the element. Until TVP8 this was a no-op, and the entire resize axis had no executable coverage (IO-RESIZE-COV) | `harness/register.ts`, `harness/env.ts` |
| A layout — one fixed 1280x800 box per element | jsdom runs no layout engine, so every element is 0x0 and no point is inside any plot | `harness/register.ts` |
| The origin `fetch` talks to | These are frontend tests; the chart-state CONTRACT is implemented exactly, including the version rule and the written flags | `harness/server.ts` |
| A market | A small catalogue of CANONICAL instruments (`instrument:v1:…`), served through the symbols table, both search routes, both ticker routes, the canonical candle route, the provider stream config and a watchlist that persists — every payload typed against `lib/api`, so a drift from the backend's shapes fails typecheck. Until TVP8 none of these existed and no test could put a pane on a canonical identity (IO-A2-COV) | `harness/market.ts`, `harness/server.ts` |
| `WebSocket` | The market stream is a live connection to Binance | `harness/env.ts` |

Nothing here mocks a component, a hook or a store: those are the subject, and a
test that mocks its subject proves the mock. No test asserts a pixel.

## Writing one

- `mountChart()` renders the workspace and waits for its first load.
- `drag`, `clickAt`, `rightClickAt`, `press`, `selectTool` are gestures.
- `server.hold(...)` stalls a response until the test releases it — that is how
  a race is reproduced rather than hoped for.
- `server.interpose(fn)` lets another device write the stored row just before
  each request is answered, which is how a refusal that is not this client's
  own conflict is reproduced for longer than one round trip.
- `advance(ms)` moves past a known debounce; `settle()` drains what is pending.
- `resize(el, box)` changes an observed element's box and lets the product
  react. Resize the element the product OBSERVES (`observedElements()` lists
  them) — there is no layout engine, so a parent's new size says nothing about
  its children's.
- `server.seedWatchlist([...])` is a returning user's list; `CANONICAL.SOLUSDT`
  and `idFor(venue, base, quote)` from `harness/market.ts` name the catalogue's
  instruments. Bars for a canonical instrument are set under its PROVIDER
  symbol: `server.setCandles("SOLUSDT", …)` serves `CANONICAL.SOLUSDT` too.
- A DOM node never reaches an assertion. `assertPresent` / `assertAbsent` take
  the node and compare a boolean; `assert.equal(node, null)` hangs the runner
  when it fails (see `harness/env.ts`).
- `resetBrowser()` belongs in `beforeEach`, `closeBrowser` in `after` — the
  chart's clock and the market stream's reconnect ladder keep Node's event loop
  alive forever otherwise.
