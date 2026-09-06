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
| `PointerEvent`, `ResizeObserver`, `matchMedia` | jsdom implements none of them | `harness/register.ts` |
| A layout — one fixed 1280x800 box per element | jsdom runs no layout engine, so every element is 0x0 and no point is inside any plot | `harness/register.ts` |
| The origin `fetch` talks to | These are frontend tests; the chart-state CONTRACT is implemented exactly, including the version rule and the written flags | `harness/server.ts` |
| `WebSocket` | The market stream is a live connection to Binance | `harness/env.ts` |

Nothing here mocks a component, a hook or a store: those are the subject, and a
test that mocks its subject proves the mock. No test asserts a pixel.

## Writing one

- `mountChart()` renders the workspace and waits for its first load.
- `drag`, `clickAt`, `rightClickAt`, `press`, `selectTool` are gestures.
- `server.hold(...)` stalls a response until the test releases it — that is how
  a race is reproduced rather than hoped for.
- `advance(ms)` moves past a known debounce; `settle()` drains what is pending.
- `resetBrowser()` belongs in `beforeEach`, `closeBrowser` in `after` — the
  chart's clock and the market stream's reconnect ladder keep Node's event loop
  alive forever otherwise.
