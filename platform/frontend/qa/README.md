# Browser QA harness

Two Playwright scripts that drive a **local** build of this frontend across
desktop and phone viewports. They are deliberately **not** part of `npm test`:
they need a browser binary and a running server, and a test suite that cannot
run offline is one people stop running.

## What they check

`viewports.mjs` — 7 routes × 5 viewports (1440, 1024, iPhone 13 portrait and
landscape, Pixel 7):

- horizontal overflow of the document, and any element extending past the
  viewport that is not inside a horizontal scroller
- uncaught page errors and console errors
- controls smaller than the 24×24 CSS-pixel minimum (an `<input>` inside a
  `<label>` is measured as the label, which is the real target)
- controls with no accessible name
- presence of `main`, `nav`, the skip link, and a top-level heading

`keyboard.mjs` — the skip link, the focus ring, and the shared dialog: that it
is announced as a dialog with a name, that focus moves inside it, that Tab
cannot leave it, that Escape closes it, that body scroll is restored, and that
focus returns to whatever opened it.

## Running them

Playwright is not a dependency of this project. Install it somewhere outside
the repository, build and start the frontend, then run the scripts:

```sh
npm --prefix /tmp/qa install playwright
npm run build && AUTH_ENABLED=false npx next start -p 3111 &
NODE_PATH=/tmp/qa/node_modules node qa/viewports.mjs
NODE_PATH=/tmp/qa/node_modules node qa/keyboard.mjs
```

`AUTH_ENABLED=false` is needed because the sign-in gate is read at build time.

## The limitation that matters

The backend needs PostgreSQL, which was not available when these were written,
so every page was exercised with its API returning 500. That is a real and
useful state — it is exactly what a user sees when the backend is down, and it
is how the error paths added in Phase 6 were reached — but it is **not** QA
against a populated system. Nothing here has seen a chart with candles on it.
