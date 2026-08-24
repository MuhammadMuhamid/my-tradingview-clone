#!/usr/bin/env python3
"""
SR+Trend v5 — Optuna Bayesian Optimizer
========================================
Drop-in upgrade for optimize.py: replaces random search with Optuna's
Tree-structured Parzen Estimator (TPE), which intelligently focuses the
search on promising regions after an initial exploration phase.

Why TPE beats pure random search here:
  - Random search of 5000 samples is essentially a Monte Carlo lottery.
  - TPE fits a probabilistic model of good vs. bad regions and samples from
    the good region, converging on high-score configs faster.
  - Typical improvement: equivalent result quality in ~30% of the samples,
    or significantly better results with the same sample budget.

Usage:
  # Basic run (Bayesian TPE, 2000 trials)
  python optimize_optuna.py --symbol APTUSDT

  # Grid search (exhaustive, slower but complete)
  python optimize_optuna.py --symbol APTUSDT --sampler grid

  # Resume a previous study (same symbol = same SQLite DB)
  python optimize_optuna.py --symbol APTUSDT --resume

  # Multi-objective (Pareto front of score vs. drawdown)
  python optimize_optuna.py --symbol APTUSDT --multi-objective

Options:
  --symbol        Required. e.g. APTUSDT
  --trials N      Number of Optuna trials (default 2000)
  --sampler       tpe (default) | grid | random | cmaes
  --min-trades N  Discard configs with fewer closed trades (default 8)
  --seed N        RNG seed (default 42)
  --data-start    YYYY-MM-DD warmup start (default 2025-10-01)
  --test-start    YYYY-MM-DD test window start (default 2025-11-01)
  --test-end      YYYY-MM-DD test window end (default today)
  --out-dir       Results folder (default ./results)
  --db-dir        SQLite storage folder (default ./optuna_dbs)
  --no-download   Skip data download
  --resume        Continue an existing study from its SQLite DB
  --multi-objective  Optimize (score, -max_dd) as a Pareto front
  --n-jobs N      Parallel workers (default 1; set >1 for multiprocessing)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import optuna
import pandas as pd

from binance_data import fetch_klines, load_csv, save_csv
from feature_bank import FeatureBank
from pine_map import format_pine_report
from retest_cache import precompute_retests
from simulate import SimResult, simulate
from strategy_sim import StrategyParams

# Silence Optuna's verbose per-trial logging (we print our own progress)
optuna.logging.set_verbosity(optuna.logging.WARNING)


# ─────────────────────────────────────────────────────────────────────────────
# Search space — same as optimize.py, structured for Optuna suggest_categorical
# ─────────────────────────────────────────────────────────────────────────────

SEARCH_SPACE: dict[str, list] = {
    "touch_atr":           [0.50, 0.65, 0.75, 0.85, 1.0, 1.2, 1.5],
    "piv_len_5":           [5, 7, 9, 11, 13, 15],
    "piv_len_15":          [7, 9, 11, 13, 15, 17],
    "piv_len_60":          [5, 7, 9, 11],
    "piv_len_240":         [5, 7, 9],
    "retest_confirm_bars": [4, 6, 8, 10, 12, 16, 20, 25],
    "prior_above_lb":      [1, 2, 3, 4, 5],
    "atr_len":             [5, 7, 10, 14],
    "sl_atr":              [0.4, 0.5, 0.6, 0.8, 1.0, 1.2],
    "struct_buff":         [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
    "tp_r":                [1.5, 1.75, 2.0, 2.25, 2.5, 3.0],
    "trail_trigger_r":     [0.25, 0.5, 0.75, 1.0, 1.25, 1.5],
    "trail_atr":           [0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0],
    "trail_style":         ["ratchet", "chandelier"],
    "min_sl_atr":          [0.10, 0.15, 0.20, 0.25],
    "require_ma_slope":    [False, True],
    "ma_slope_lb":         [3, 5, 8],
    "use_local_trend":     [False, True],
    "local_ema_fast":      [13, 21],
    "local_ema_slow":      [34, 55],
    "use_volume_filter":   [False, True],
    "vol_ma_len":          [14, 20],
    "vol_mult_min":        [0.8, 1.0, 1.2, 1.5],
    "use_hh_structure":    [False, True],
    "hh_pivot_len":        [5, 7, 9],
    "lr_len":              [5, 6, 8, 10, 12, 15],
}

LOCKED = dict(
    ma1_len=200, ma3_len=400, vwma_len=200,
    st_atr_len=15, st_mult=2.5, lr_tf="5",
    use_ma_trend=True, use_vwma=True, use_supertrend=True, use_linreg=True,
    fee_pct=0.075, sl_swing_lb=25, reclaim_pierce_atr=0.05,
)

USE_1M_DATA   = False
TF_MAP        = {"1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h"}
INTERVALS_BASE = ["5m", "15m", "1h", "4h"]
INTERVALS_1M   = ["1m", "5m", "15m", "1h", "4h"]


# ─────────────────────────────────────────────────────────────────────────────
# Shared state (populated before the study starts, read by objective fn)
# ─────────────────────────────────────────────────────────────────────────────

_bank: FeatureBank | None = None
_retest_cache: dict[tuple, dict] = {}
_t0: pd.Timestamp | None = None
_t1: pd.Timestamp | None = None
_min_trades: int = 8
_touch_vals: list  = []
_prior_vals: list  = []


def _frame_key(p: StrategyParams) -> tuple:
    return (p.piv_len_5, p.piv_len_15, p.piv_len_60, p.piv_len_240, p.atr_len)


def _get_retest(p: StrategyParams, d: pd.DataFrame) -> np.ndarray:
    key = _frame_key(p)
    if key not in _retest_cache:
        _retest_cache[key] = precompute_retests(
            d, _touch_vals, _prior_vals,
            reclaim_pierce_atr=p.reclaim_pierce_atr,
        )
    return _retest_cache[key][(p.touch_atr, p.prior_above_lb)]


# ─────────────────────────────────────────────────────────────────────────────
# Optuna objective — single-objective
# ─────────────────────────────────────────────────────────────────────────────

def objective(trial: optuna.Trial) -> float:
    """Returns composite_score (higher = better). Returns 0.0 for invalid configs."""
    kwargs = {**LOCKED}
    for name, choices in SEARCH_SPACE.items():
        kwargs[name] = trial.suggest_categorical(name, choices)

    p = StrategyParams(**kwargs)
    d = _bank.build_frame(p)
    r = simulate(d, p, _t0, _t1, r_any=_get_retest(p, d))

    if r.trades < _min_trades:
        # Prune trials that produce too few trades early
        raise optuna.exceptions.TrialPruned()

    return r.composite_score


# ─────────────────────────────────────────────────────────────────────────────
# Optuna objective — multi-objective (score maximise, drawdown minimise)
# ─────────────────────────────────────────────────────────────────────────────

def objective_multi(trial: optuna.Trial) -> tuple[float, float]:
    """Returns (composite_score, max_dd_pct). Maximise score, minimise drawdown."""
    kwargs = {**LOCKED}
    for name, choices in SEARCH_SPACE.items():
        kwargs[name] = trial.suggest_categorical(name, choices)

    p = StrategyParams(**kwargs)
    d = _bank.build_frame(p)
    r = simulate(d, p, _t0, _t1, r_any=_get_retest(p, d))

    if r.trades < _min_trades:
        raise optuna.exceptions.TrialPruned()

    return r.composite_score, r.max_dd_pct


# ─────────────────────────────────────────────────────────────────────────────
# Sampler factory
# ─────────────────────────────────────────────────────────────────────────────

def make_sampler(name: str, seed: int, multi: bool) -> optuna.samplers.BaseSampler:
    if name == "tpe":
        # n_startup_trials: random exploration before TPE model kicks in.
        # 200-400 is a good range for a ~25-parameter categorical space.
        n_startup = min(400, max(100, len(SEARCH_SPACE) * 10))
        if multi:
            return optuna.samplers.TPESampler(
                n_startup_trials=n_startup, seed=seed, multivariate=True
            )
        return optuna.samplers.TPESampler(
            n_startup_trials=n_startup, seed=seed, multivariate=True,
            constant_liar=True,  # helps with parallel workers
        )
    if name == "cmaes":
        # CMA-ES works best with continuous params — wraps categoricals as ints
        return optuna.samplers.CmaEsSampler(seed=seed)
    if name == "random":
        return optuna.samplers.RandomSampler(seed=seed)
    if name == "grid":
        # Full grid search — enumerates ALL combinations
        total = 1
        for v in SEARCH_SPACE.values():
            total *= len(v)
        print(f"  Grid search: {total:,} total combinations")
        return optuna.samplers.GridSampler(SEARCH_SPACE)
    raise ValueError(f"Unknown sampler: {name}")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers (shared with optimize.py)
# ─────────────────────────────────────────────────────────────────────────────

def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def parse_date(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def find_or_download(symbol: str, start: str, end: str, data_dir: Path) -> dict[str, Path]:
    intervals = INTERVALS_1M if USE_1M_DATA else INTERVALS_BASE
    paths: dict[str, Path] = {}
    for tf in intervals:
        fname = data_dir / f"{symbol}_{tf}_{start}_{end}.csv"
        if not fname.exists():
            print(f"  Downloading {symbol} {tf} …", end=" ", flush=True)
            start_ms = int(parse_date(start).timestamp() * 1000)
            end_ms   = int(parse_date(end).timestamp()   * 1000)
            df = fetch_klines(symbol, TF_MAP[tf], start_ms, end_ms)
            if df.empty:
                print(f"WARNING: no data for {tf}")
                continue
            save_csv(df, fname)
            print(f"{len(df)} bars")
        else:
            print(f"  {tf}: cached {fname.name}")
        paths[tf] = fname
    return paths


def print_top(trials: list[optuna.Trial], symbol: str, test_start: str, test_end: str,
              n: int = 20) -> None:
    valid = [t for t in trials if t.state == optuna.trial.TrialState.COMPLETE and t.value > 0]
    valid.sort(key=lambda t: t.value, reverse=True)

    print(f"\n{'='*80}")
    print(f"  TOP {n}  —  {symbol}  |  {test_start} → {test_end}")
    print(f"{'='*80}")

    for i, t in enumerate(valid[:n], 1):
        p      = StrategyParams(**{**LOCKED, **t.params})
        flags  = []
        if p.require_ma_slope:  flags.append("slope")
        if p.use_local_trend:   flags.append(f"EMA{p.local_ema_fast}/{p.local_ema_slow}")
        if p.use_volume_filter: flags.append(f"vol×{p.vol_mult_min}")
        if p.use_hh_structure:  flags.append("HH")
        flag_s = " ".join(flags) or "base"
        trail_s = "chand" if p.trail_style == "chandelier" else "ratch"

        # Retrieve metrics stored in user_attrs
        net  = t.user_attrs.get("net_pct",       "?")
        wr   = t.user_attrs.get("win_rate",       "?")
        pf   = t.user_attrs.get("profit_factor",  "?")
        dd   = t.user_attrs.get("max_dd_pct",     "?")
        trd  = t.user_attrs.get("trades",         "?")

        key_s = (f"tpR={p.tp_r} trT={p.trail_trigger_r} trA={p.trail_atr} "
                 f"sb={p.struct_buff} {trail_s} | {flag_s}")
        net_s = f"{net:+.2f}%" if isinstance(net, float) else str(net)
        wr_s  = f"{wr*100:.1f}%" if isinstance(wr, float) else str(wr)
        pf_s  = f"{pf:.2f}"    if isinstance(pf, float) else str(pf)
        dd_s  = f"{dd:.2f}%"   if isinstance(dd, float) else str(dd)
        trd_s = str(trd)

        print(f"{i:<4} {t.value:>8.4f} {net_s:>8} {wr_s:>7} {pf_s:>6} {dd_s:>7} {trd_s:>5}  {key_s}")


# ─────────────────────────────────────────────────────────────────────────────
# Objective wrapper that stores metrics in trial.user_attrs (for display)
# ─────────────────────────────────────────────────────────────────────────────

def _make_instrumented_objective(multi: bool):
    """Returns an objective function that stores extra metrics in user_attrs."""
    def _obj(trial: optuna.Trial):
        kwargs = {**LOCKED}
        for name, choices in SEARCH_SPACE.items():
            kwargs[name] = trial.suggest_categorical(name, choices)

        p = StrategyParams(**kwargs)
        d = _bank.build_frame(p)
        r = simulate(d, p, _t0, _t1, r_any=_get_retest(p, d))

        if r.trades < _min_trades:
            raise optuna.exceptions.TrialPruned()

        # Store for display / export
        trial.set_user_attr("net_pct",       round(r.net_pct,      3))
        trial.set_user_attr("win_rate",       round(r.win_rate,     4))
        trial.set_user_attr("profit_factor",  round(r.profit_factor,4))
        trial.set_user_attr("max_dd_pct",     round(r.max_dd_pct,   3))
        trial.set_user_attr("trades",         r.trades)

        if multi:
            return r.composite_score, r.max_dd_pct
        return r.composite_score

    return _obj


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    global _bank, _t0, _t1, _min_trades, _touch_vals, _prior_vals

    ap = argparse.ArgumentParser(description="SR+Trend v5 Optuna optimizer")
    ap.add_argument("--symbol",          required=True)
    ap.add_argument("--trials",          type=int,  default=2000)
    ap.add_argument("--sampler",         default="tpe",
                    choices=["tpe", "grid", "random", "cmaes"])
    ap.add_argument("--min-trades",      type=int,  default=8)
    ap.add_argument("--seed",            type=int,  default=42)
    ap.add_argument("--data-start",      default="2025-10-01")
    ap.add_argument("--test-start",      default="2025-11-01")
    ap.add_argument("--test-end",        default=None)
    ap.add_argument("--out-dir",         default="results")
    ap.add_argument("--db-dir",          default="optuna_dbs")
    ap.add_argument("--no-download",     action="store_true")
    ap.add_argument("--resume",          action="store_true",
                    help="Continue existing study from SQLite DB")
    ap.add_argument("--multi-objective", action="store_true",
                    help="Optimise (score, drawdown) as Pareto front")
    ap.add_argument("--n-jobs",          type=int,  default=1,
                    help="Parallel Optuna workers (>1 uses multiprocessing)")
    args = ap.parse_args()

    symbol   = args.symbol.upper()
    test_end = args.test_end or today_str()
    data_dir = Path("data");      data_dir.mkdir(parents=True, exist_ok=True)
    out_dir  = Path(args.out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    db_dir   = Path(args.db_dir);  db_dir.mkdir(parents=True, exist_ok=True)

    _min_trades = args.min_trades
    _touch_vals = SEARCH_SPACE["touch_atr"]
    _prior_vals = SEARCH_SPACE["prior_above_lb"]

    print(f"\n{'='*60}")
    print(f"  SR+Trend v5 Optuna Optimizer — {symbol}")
    print(f"  Sampler  : {args.sampler.upper()}  |  Trials: {args.trials}")
    print(f"  Multi-obj: {args.multi_objective}")
    print(f"  Data:  {args.data_start} → {test_end}")
    print(f"  Test:  {args.test_start} → {test_end}")
    print(f"{'='*60}\n")

    # ── 1. Data ───────────────────────────────────────────────────────────────
    intervals = INTERVALS_1M if USE_1M_DATA else INTERVALS_BASE
    if not args.no_download:
        print("[ Step 1 ] Data")
        paths = find_or_download(symbol, args.data_start, test_end, data_dir)
    else:
        paths = {tf: next(data_dir.glob(f"{symbol}_{tf}_*.csv"), None) for tf in intervals}

    frames: dict[str, pd.DataFrame] = {}
    for tf, p in paths.items():
        if p:
            frames[tf] = load_csv(p)
    if "1m" not in frames:
        frames["1m"] = frames["1h"]

    # ── 2. Feature bank ────────────────────────────────────────────────────────
    print("\n[ Step 2 ] Feature bank …")
    t0_b = time.time()
    seed_p = StrategyParams(**LOCKED,
        piv_len_5=9, piv_len_15=13, piv_len_60=7, piv_len_240=7, atr_len=7,
        local_ema_fast=21, local_ema_slow=55, vol_ma_len=20, hh_pivot_len=7, lr_len=8,
    )
    _bank = FeatureBank(frames, SEARCH_SPACE, fixed=seed_p)
    print(f"  Built in {time.time()-t0_b:.1f}s")

    _t0 = pd.Timestamp(args.test_start, tz="UTC")
    _t1 = pd.Timestamp(test_end, tz="UTC")

    # ── 3. Optuna study ────────────────────────────────────────────────────────
    study_name = f"sr_trend_v5_{symbol}_{args.sampler}"
    db_path    = db_dir / f"{study_name}.db"
    storage    = f"sqlite:///{db_path}"

    load_if_exists = args.resume
    sampler = make_sampler(args.sampler, args.seed, args.multi_objective)
    pruner  = optuna.pruners.MedianPruner(n_startup_trials=50, n_warmup_steps=0)

    if args.multi_objective:
        study = optuna.create_study(
            study_name=study_name,
            storage=storage,
            load_if_exists=load_if_exists,
            sampler=sampler,
            directions=["maximize", "minimize"],  # score ↑, drawdown ↓
        )
    else:
        study = optuna.create_study(
            study_name=study_name,
            storage=storage,
            load_if_exists=load_if_exists,
            sampler=sampler,
            pruner=pruner,
            direction="maximize",
        )

    obj = _make_instrumented_objective(args.multi_objective)

    print(f"\n[ Step 3 ] Optuna search — {args.trials} trials")
    print(f"  Study:   {study_name}")
    print(f"  Storage: {db_path}")
    existing = len(study.trials)
    if existing:
        print(f"  Resuming: {existing} trials already completed")

    t0_opt = time.time()

    def _progress_callback(study: optuna.Study, trial: optuna.Trial) -> None:
        n = len(study.trials)
        if n % 200 == 0:
            elapsed = time.time() - t0_opt
            eta     = elapsed / n * (args.trials - n) if n else 0
            if args.multi_objective:
                best_n = len(study.best_trials)
                print(f"  … {n:>6}/{args.trials}  pareto_front={best_n}  "
                      f"elapsed={elapsed:.0f}s  eta={eta:.0f}s")
            else:
                best = study.best_value if study.best_trial else 0
                print(f"  … {n:>6}/{args.trials}  best_score={best:.4f}  "
                      f"elapsed={elapsed:.0f}s  eta={eta:.0f}s")

    study.optimize(
        obj,
        n_trials=args.trials,
        n_jobs=args.n_jobs,
        callbacks=[_progress_callback],
        show_progress_bar=False,
        catch=(Exception,),
    )

    elapsed_total = time.time() - t0_opt
    print(f"\n  Finished in {elapsed_total:.1f}s  "
          f"({elapsed_total/max(1,args.trials)*1000:.1f}ms/trial)")

    # ── 4. Results ─────────────────────────────────────────────────────────────
    all_trials = study.trials

    if args.multi_objective:
        pareto = study.best_trials
        print(f"\n  Pareto-front size: {len(pareto)} non-dominated configs")
        pareto.sort(key=lambda t: t.values[0], reverse=True)
        for i, t in enumerate(pareto[:10], 1):
            score, dd = t.values
            net = t.user_attrs.get("net_pct", "?")
            net_s = f"{net:+.2f}%" if isinstance(net, float) else str(net)
            print(f"  [{i:>2}] score={score:.4f}  dd={dd:.2f}%  net={net_s}")

        best_trial = pareto[0] if pareto else None
    else:
        print_top(all_trials, symbol, args.test_start, test_end)
        try:
            best_trial = study.best_trial
        except ValueError:
            best_trial = None

    if best_trial is None:
        sys.exit("No valid trials found. Lower --min-trades or widen date range.")

    best_params = StrategyParams(**{**LOCKED, **best_trial.params})
    best_score  = best_trial.values[0] if args.multi_objective else best_trial.value

    # ── 5. Save ────────────────────────────────────────────────────────────────
    json_path = out_dir / f"{symbol}_optuna_best.json"
    pine_path = out_dir / f"{symbol}_optuna_pine.txt"

    payload = {
        "symbol":        symbol,
        "sampler":       args.sampler,
        "trials":        args.trials,
        "data_start":    args.data_start,
        "test_start":    args.test_start,
        "test_end":      test_end,
        "best_score":    best_score,
        "best_metrics":  best_trial.user_attrs,
        "best_params":   best_trial.params,
        "locked":        LOCKED,
        "study_db":      str(db_path),
    }
    json_path.write_text(json.dumps(payload, indent=2))

    pine_txt = format_pine_report(best_params, symbol=symbol, score=best_score)
    pine_path.write_text(pine_txt)

    print(f"\n{'='*60}")
    print(f"  BEST — Score {best_score:.4f}")
    m = best_trial.user_attrs
    print(f"    Net%={m.get('net_pct',0):+.2f}%  WR={m.get('win_rate',0)*100:.1f}%  "
          f"PF={m.get('profit_factor',0):.2f}  DD={m.get('max_dd_pct',0):.2f}%  "
          f"Trades={m.get('trades',0)}")
    print(f"  Saved → {json_path}")
    print(f"  Pine  → {pine_path}")
    print(f"  DB    → {db_path}  (resume with --resume)")
    print(f"{'='*60}\n")

    # Filter consensus across top-10 (same as optimize.py)
    valid_trials = sorted(
        [t for t in all_trials if t.state == optuna.trial.TrialState.COMPLETE and (t.value or 0) > 0],
        key=lambda t: t.value or 0, reverse=True,
    )
    top10 = valid_trials[:10]
    if top10:
        slope_on  = sum(1 for t in top10 if t.params.get("require_ma_slope"))
        local_on  = sum(1 for t in top10 if t.params.get("use_local_trend"))
        vol_on    = sum(1 for t in top10 if t.params.get("use_volume_filter"))
        hh_on     = sum(1 for t in top10 if t.params.get("use_hh_structure"))
        chand_on  = sum(1 for t in top10 if t.params.get("trail_style") == "chandelier")
        print("  Filter consensus in top-10:")
        print(f"    MA slope ON : {slope_on}/10")
        print(f"    Local EMA ON: {local_on}/10")
        print(f"    Volume ON   : {vol_on}/10")
        print(f"    HH struct ON: {hh_on}/10")
        print(f"    Chandelier  : {chand_on}/10")


if __name__ == "__main__":
    main()
