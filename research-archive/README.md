# Research archive

Retired research trees. Nothing here runs, nothing here is imported by the
platform or the execution bot, and no number in here may be used to select a
configuration for deployment.

It exists because the alternative — deleting it — would destroy the only record
of experiments whose conclusions still circulate in the root documents and in
`reports/`. Each tree carries an `ARCHIVED.md` naming, with line references,
every defect the audit confirmed in it, so a number found here can be traced to
the reason it is unreliable.

| Tree | Retired because | Findings |
|---|---|---|
| [`tv_autotuner/`](tv_autotuner/ARCHIVED.md) | Drove the real TradingView UI over an unauthenticated DevTools port; measurement could record the previous configuration's metrics against a new genome | `TV-02`–`TV-06`, `TV-13`–`TV-25` |
| [`backtest-spot/`](backtest-spot/ARCHIVED.md) | Six confirmed methodology defects, including look-ahead in the feature alignment and an entry point that can never fire | `TV-07`–`TV-12` |
| [`one-off-apply-scripts/`](one-off-apply-scripts/ARCHIVED.md) | Two scripts that applied one specific set of coins and ranks, from `/tmp` files that no longer exist | `OPT-26` |

`approach1_ui_automation/` was **deleted**, not archived. It scripted a password
login to tradingview.com and had never produced any output — there was no
evidence in it to preserve, and automating a login against someone's account is
outside what this system does. It is recoverable from Git history at
`a0a8b0c^:approach1_ui_automation/` if it is ever needed for reference (`TV-01`).

The five copies of `opt_apply.py` under `platform/backend/*/` went with it: each
imported `tv_autotuner.autotuner` to push a local optimizer result into the live
TradingView chart over the same DevTools bridge, through an absolute path that
does not exist on any current machine.

## What replaced it

Configuration search lives in the thirteen TypeScript trees under
`platform/backend/`, each registered in its own `tree.json` and reachable from
the application. They run against stored Binance candles with a stated cost
model, rather than against a scraped browser report. See
[`docs/COST-MODELS.md`](../docs/COST-MODELS.md) and
[`docs/RESEARCH-METHODOLOGY.md`](../docs/RESEARCH-METHODOLOGY.md).

## Rules for this directory

- Nothing here is on an import path, a service, a Docker stage or a CI job.
  `scripts/ci/check-repo-hygiene.sh` fails if that stops being true.
- Do not "fix" a tree in place. A corrected result would sit beside uncorrected
  ones with nothing to tell them apart, which is the confusion the archive
  exists to end. Start a new tree.
- Do not delete the result files. They are the evidence behind conclusions that
  are still quoted.
