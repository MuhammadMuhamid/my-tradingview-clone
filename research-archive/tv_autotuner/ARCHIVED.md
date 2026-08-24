# tv_autotuner — ARCHIVED

**Status: retired. The driver has been removed; the results it produced are kept
as evidence and must not be used to select a configuration.**

This tree optimised a strategy by driving the **real TradingView desktop
application**: it set the study's inputs over the Chrome DevTools Protocol,
scraped the Strategy Tester report out of the page, and used that as the
objective for a genetic search.

## What was removed, and why

`autotuner.py`, `show.py` and `requirements.txt` are deleted from the working
tree. They are recoverable from Git history (`a0a8b0c^:tv_autotuner/`).

- **An unauthenticated debugging port.** The driver started the TradingView
  binary with `--remote-debugging-port=9222` and connected to
  `http://localhost:9222/json`. Anything able to reach that port — any local
  process, and any page able to make a request to it — could drive the
  application, read the session and act as the logged-in user. There was no
  authentication of any kind on the bridge.
- **A session cookie jar written inside the tree.** A saved browser session is a
  live credential. `.gitignore` now refuses `tv_session/`, `cookies.json`,
  `*_cookies.json`, `storageState.json` and `*.har` anywhere in the repository.
- **Measurement that could record the wrong configuration's numbers.**
  `evaluate()` waited up to 90 seconds for the report's fingerprint to change
  after new inputs were set. On timeout it logged *"Recalc wait timed out
  (report may be unchanged) — accepting current read"* and returned the scrape
  anyway. If the chart had not finished recalculating, those were the
  **previous** configuration's metrics, recorded against the **new** genome, and
  written permanently into `results/<coin>.jsonl` and possibly into
  `best/<coin>.json`. Nothing in the record marks which rows this happened to,
  which is why no row here can be trusted individually.
- **A fourth independent copy of the ask/tell genetic algorithm, with a fourth
  objective definition** (`TV-13`). The five TypeScript trees' `optimizer.ts`
  files each say they are a port of this driver; they are not byte-equivalent
  ports, and the objective differs. No result here is comparable with a
  TypeScript tree's result.
- **No in-sample / out-of-sample split** (`TV-12`). Every configuration was
  scored and reported on the same window, over ~252 evaluations per coin against
  a search space of ~1.48e19, with winners crowned on 39–148 trades.
- **Automating the TradingView UI is outside what this system does.** The
  platform is a private internal research and Binance Spot trading system. It
  does not drive, scrape or automate a TradingView account.

## What was kept

`best/`, `results/`, `SUMMARY.json`, `params.json`, `seeds.json`,
`backup_inputs.json`, `coins.txt`, `seeds_example.json` and the original
`README.md`. These are the only record of the experiment and of the manual
seed configurations that came from it.

`seeds.json` in particular documents where several "manual best" configurations
came from — screenshots, at a 0.05 % fee that no tree runs. Read it as
provenance, not as a result.

## If you are reading a number from this tree

It was measured by scraping a browser at an unstated moment in a recalculation,
under an objective that exists nowhere else, on the same window it was selected
on. Treat it as a record of what was tried, not as a measurement.
