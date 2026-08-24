# backtest-spot — ARCHIVED

**Status: retired. Six confirmed methodology defects. No number this tree
produced may be used to select a configuration.**

A Python re-implementation of the SR/MA spot strategy with five separate
optimizer drivers (`optimize.py`, `optimize_optuna.py`, `optimize_v8.py`,
`optimize_morpho.py`, `optimize_tiausdt.py`) over a shared feature bank. It is
superseded by the thirteen TypeScript trees under `platform/backend/`, which
run against stored Binance candles with a stated, machine-checked cost model.

The code is kept, unmodified, because `results/` and the numbers quoted from it
elsewhere have no other provenance. Every defect below was re-verified by
reading this checkout, not carried over from the audit's text.

## Confirmed defects

**`TV-07` — an open position at the end of the window is charged as a total
loss.** `simulate.py:314` computes `net_pct = (cash / capital - 1) * 100` from
cash alone. An entry does `cash -= alloc + fee` (`:225`) and only a closing
branch adds proceeds back. A run that ends in a position therefore reports
roughly −93 pp on a 930-of-1000 allocation, whatever the position is worth.
Every search using this objective is systematically biased against
configurations that hold at the window edge. There is also no `cash >= alloc`
guard before an entry, so cash can go negative.

**`TV-08` — the "1m × 200 SMA" trend gate is computed from 1-hour bars in three
of five drivers.** `optimize.py:118` and `optimize_optuna.py:111` set
`USE_1M_DATA = False`, which selects `INTERVALS_BASE` and aliases the 1m frame
to the 1h frame; `optimize_v8.py:131` sets it `True`. Every "best config" from
the first two was selected under a trend filter roughly sixty times longer than
the one it claims to mirror, and the two sets of results are not comparable with
each other.

**`TV-09` — look-ahead in the higher-timeframe alignment.** `align_htf_to_5m`
(`strategy_sim.py:284-289`) is a backward `merge_asof` on frames indexed by
**open time** (`binance_data.py:70`). Without a correction, a 5m bar at 09:00
receives the value of the 1h bar that *opens* at 09:00 — a value not knowable
until 09:59. The authors identified exactly this and corrected it for the 1h
moving average with `_1h_prior_offset = -1min` (`feature_bank.py:77,87`) and for
the 1m frame with `+4min` (`:73,86`). The support pivots on all four timeframes
(`:59-65`) and the 4h VWMA (`:93-97`) are aligned with **no offset**. The
support pivots are the entry trigger.

**`TV-10` — the documented entry point can never fire an entry.**
`run_backtest.py:47` calls `simulate(d, p, t0, t1)`, omitting `r_any`, the
retest mask. `simulate.py:98-99` then defaults it to all-`False`, so
`last_retest_i` never moves off its `-10_000` sentinel (`:167,181-182`) and the
entry guard `0 <= i - last_retest_i <= p.retest_confirm_bars` (`:198`) can never
be satisfied. Confirmed by reading the guard; this checkout has no market data
to execute it against.

**`TV-11` — the exit MA is hardcoded, and the generated report tells the user a
different one.** `feature_bank.py:148-158` computes the exit trigger from a
**1h × 100 VWMA** crossunder. `pine_map.py:75` prints
`# exitMaTf=4h, exitMaLen=100, exitMaType=SMA (ON)` into the report the user is
told to configure on their chart. `StrategyParams.exit_ma_tf`, `.exit_ma_len`
and `.exit_ma_type` (`strategy_sim.py:81-83`) are set by `run_sim.py` and
`optimize_v8.py` and read by nothing in the feature bank.

**`TV-12` — no in-sample / out-of-sample split anywhere.** None of the three
main drivers contains a train/test boundary of any kind. Every configuration is
scored and reported on the same window.

## Why it was not fixed in place

Correcting the alignment or the terminal-position accounting changes every
number this tree ever produced. There is no stored market data in the
repository — `backtest-spot/data/` is gitignored and absent — so a correction
could not be validated here, and a corrected result sitting beside uncorrected
ones with nothing to distinguish them is worse than an honestly labelled
archive. If this line of work is resumed, start a new tree with a split, a
stated cost model and a registry entry, as the TypeScript trees have.

## Recovering it

Everything here is tracked. The pre-archive location was `backtest-spot/` at the
repository root, up to commit `3826ee2`.
