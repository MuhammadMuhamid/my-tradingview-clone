"""Empirical calibration — §6.2. Off by default, and it has to be earned.

This is the **only** part of the system permitted to use the word "probability",
and only because it is backed by a forward-return sample. Everything about the
presentation is defensive on purpose:

* `n` is reported next to every rate, always.
* A decile with fewer than `min_decile_samples` observations reports
  `insufficient data` — never a percentage derived from a handful of bars.
* The calibration window is reported as dates, with a warning under six months.
* It is computed **per symbol**. A rate calibrated on BTC does not transfer.

Read `README.md` before trusting any number this produces. In particular the
samples overlap: at a 24-bar horizon walking every bar, each observation shares
23 bars with its neighbour, so `n` counts observations, not independent ones.

## Why there is a fast path

Scoring one bar means computing eight indicators, ~53ms. Walking two thousand
bars that way is nearly two minutes per symbol. Instead every indicator that has
a full-history series form is computed once, O(n) rather than O(n^2), and read
per bar. That substitution is legitimate only because `series(full)[i]` equals
`compute(history[:i+1])` exactly — which is what `tests/test_no_lookahead.py`
establishes, and what `test_fast_path_matches_the_slow_path` re-checks end to end
against the real `compute()` functions.

S&R has no series form: its horizon and invalidation sweep are both defined
relative to the end of the data, so it is genuinely recomputed per bar.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from . import ta
from .indicators import adx as adx_mod
from .indicators import candles as candles_mod
from .indicators import sr as sr_mod
from .indicators import supertrend as st_mod
from .indicators import vfi as vfi_mod
from .scoring import compute as compute_score
from .timeframes import duration_ms

log = logging.getLogger(__name__)

DEFAULTS: dict[str, Any] = {
    "horizon_bars": 24,
    "target_atr": 2.0,
    "stop_atr": 1.0,
    "min_decile_samples": 100,
    "deciles": 10,
    "max_bars": 2000,
    "atr_length": 14,
    "min_window_days": 182,     # "under 6 months" warning threshold
}

INSUFFICIENT = "insufficient data"
DAY_MS = 86_400_000
CALCULATION_VERSION = "scanner-calibration-mtf-v1"


# --- forward-return labelling -----------------------------------------


@dataclass(frozen=True)
class Label:
    outcome: int | None   # 1 target first, 0 stop first, None neither within horizon
    ambiguous: bool       # target and stop both inside the same bar's range


def label_bar(
    high: np.ndarray,
    low: np.ndarray,
    entry: float,
    atr: float,
    i: int,
    horizon: int,
    target_atr: float,
    stop_atr: float,
) -> Label:
    """Did price reach +X*ATR before -Y*ATR, within `horizon` bars?

    When a single bar's range spans both levels the order inside that bar is
    unknowable from OHLC, so it is resolved as a **loss** and counted separately.
    Resolving it the other way is the single easiest place to manufacture a
    flattering hit rate.
    """
    target = entry + target_atr * atr
    stop = entry - stop_atr * atr
    end = min(i + horizon, len(high) - 1)

    for j in range(i + 1, end + 1):
        hit_target = high[j] >= target
        hit_stop = low[j] <= stop
        if hit_target and hit_stop:
            return Label(0, True)
        if hit_target:
            return Label(1, False)
        if hit_stop:
            return Label(0, False)
    return Label(None, False)


# --- fast path: per-bar indicator values ------------------------------


def _bars_since(flags: np.ndarray) -> np.ndarray:
    """For each bar, how many bars since `flags` was last true. -1 if never."""
    out = np.full(len(flags), -1, dtype="int64")
    last = -1
    for i, flag in enumerate(flags):
        if flag:
            last = i
        out[i] = -1 if last < 0 else i - last
    return out


def indicator_frames(df: pd.DataFrame, config: dict) -> list[dict]:
    """Per-bar indicator payloads, shaped exactly like the live `compute()` output.

    Only the fields the scorer actually reads are populated; anything else would
    be dead weight across thousands of bars.
    """
    params = {k: v.get("params", {}) for k, v in config["indicators"].items()}
    n = len(df)

    atr14 = ta.atr(df, int(params.get("ema", {}).get("atr_length", 14))).to_numpy()
    close = df["close"].to_numpy(dtype="float64")

    # EMA
    lengths = [int(x) for x in params.get("ema", {}).get("lengths", [21, 50, 100, 200])]
    emas = {L: ta.ema(df["close"], L).to_numpy() for L in lengths}

    # RSI
    rsi_len = int(params.get("rsi", {}).get("length", 14))
    rsi = ta.rsi(df["close"], rsi_len).to_numpy()

    # MACD
    mp = params.get("macd", {})
    fast, slow, sig = int(mp.get("fast", 12)), int(mp.get("slow", 26)), int(mp.get("signal", 9))
    macd_line = ta.ema(df["close"], fast) - ta.ema(df["close"], slow)
    macd_sig = ta.ema(macd_line, sig)
    macd_hist = (macd_line - macd_sig).to_numpy()
    above = (macd_line > macd_sig)
    crossed = (above.ne(above.shift(1)) & above.shift(1).notna() & macd_line.notna()).to_numpy()
    macd_bars = _bars_since(crossed)

    # ADX
    ap = params.get("adx", {})
    plus, minus = adx_mod._dirmov(df, int(ap.get("diLen", 14)))
    total = plus + minus
    dx = (plus - minus).abs() / total.where(total != 0.0, 1.0)
    adx_vals = (100.0 * ta.rma(dx, int(ap.get("adxLen", 14)))).to_numpy()
    plus_v, minus_v = plus.to_numpy(), minus.to_numpy()
    ranging_below = float(ap.get("ranging_below", 20.0))
    trending_above = float(ap.get("trending_above", 25.0))

    # VFI
    vfi_df = vfi_mod.series(df, params.get("vfi"))
    vfi_v = vfi_df["vfi"].to_numpy()
    vfi_d = vfi_df["d"].to_numpy()

    # Supertrend
    st = st_mod.bands(df, params.get("supertrend"))
    st_trend = st["trend"].to_numpy()
    st_flips = np.concatenate([[False], st_trend[1:] != st_trend[:-1]])
    st_bars = _bars_since(st_flips)

    candle_params = {**candles_mod.DEFAULTS, **(params.get("candles") or {})}
    lookback = int(candle_params["lookback"])

    frames: list[dict] = []
    for i in range(n):
        atr = float(atr14[i]) if np.isfinite(atr14[i]) else None

        ema_out: dict[str, Any] = {"atr": atr}
        values = []
        for L in lengths:
            v = emas[L][i]
            v = float(v) if np.isfinite(v) else None
            ema_out[f"ema_{L}"] = v
            values.append(v)
            ema_out[f"dist_atr_{L}"] = (
                (close[i] - v) / atr if (v is not None and atr) else None
            )
        ordered = [ema_out[f"ema_{L}"] for L in sorted(lengths)]
        if all(v is not None for v in ordered) and len(ordered) > 1:
            if all(a > b for a, b in zip(ordered, ordered[1:])):
                ema_out["stack"] = "bull"
            elif all(a < b for a, b in zip(ordered, ordered[1:])):
                ema_out["stack"] = "bear"
            else:
                ema_out["stack"] = "mixed"
        else:
            ema_out["stack"] = None

        rsi_now = float(rsi[i]) if np.isfinite(rsi[i]) else None
        rsi_prev = float(rsi[i - 1]) if i > 0 and np.isfinite(rsi[i - 1]) else None

        adx_now = float(adx_vals[i]) if np.isfinite(adx_vals[i]) else None
        regime = None
        if adx_now is not None:
            regime = (
                "ranging" if adx_now < ranging_below
                else "trending" if adx_now > trending_above
                else "transitional"
            )

        detected: list[dict] = []
        seen: set[str] = set()
        for back in range(lookback):
            j = i - back
            if j < 0 or atr is None or atr <= 0:
                break
            if (float(df["high"].iloc[j]) - float(df["low"].iloc[j])) < float(
                candle_params["min_body_atr"]
            ) * float(atr14[j]):
                continue
            for hit in candles_mod._detect_at(df, j, candle_params, float(atr14[j])):
                if hit["name"] not in seen:
                    seen.add(hit["name"])
                    detected.append({**hit, "bars_ago": back})
        detected.sort(key=lambda h: (h["bars_ago"], -h["strength"], h["name"]))
        bias = "none"
        if detected:
            newest = detected[0]["bars_ago"]
            dirs = {h["direction"] for h in detected if h["bars_ago"] == newest}
            dirs.discard("none")
            bias = dirs.pop() if len(dirs) == 1 else "none"

        frames.append({
            "ema": ema_out,
            "rsi": {
                "rsi": rsi_now,
                "rsi_prev": rsi_prev,
                "slope": None if rsi_now is None or rsi_prev is None else rsi_now - rsi_prev,
            },
            "macd": {
                "hist": float(macd_hist[i]) if np.isfinite(macd_hist[i]) else None,
                "bars_since_cross": int(macd_bars[i]) if macd_bars[i] >= 0 else None,
            },
            "adx": {
                "adx": adx_now,
                "plus_di": float(plus_v[i]) if np.isfinite(plus_v[i]) else None,
                "minus_di": float(minus_v[i]) if np.isfinite(minus_v[i]) else None,
                "regime": regime,
                "direction": (
                    None if not (np.isfinite(plus_v[i]) and np.isfinite(minus_v[i]))
                    else ("bull" if plus_v[i] > minus_v[i] else "bear")
                ),
            },
            "vfi": {
                "vfi": float(vfi_v[i]) if np.isfinite(vfi_v[i]) else None,
                "hist": float(vfi_d[i]) if np.isfinite(vfi_d[i]) else None,
                "slope": (
                    float(vfi_v[i] - vfi_v[i - 1])
                    if i > 0 and np.isfinite(vfi_v[i]) and np.isfinite(vfi_v[i - 1])
                    else None
                ),
            },
            "supertrend": {
                "direction": int(st_trend[i]),
                "bars_since_flip": int(st_bars[i]) if st_bars[i] >= 0 else None,
            },
            "candles": {"patterns": detected, "net_bias": bias},
            "sr": None,   # filled per bar by the walk; see the module docstring
        })
    return frames


def source_bar_indices(
    decisions: pd.DataFrame,
    source: pd.DataFrame,
    decision_timeframe: str,
    source_timeframe: str,
) -> np.ndarray:
    """Latest source bar closed at each decision bar's close, or ``-1``.

    The live scanner reads the newest independently confirmed bar from every
    configured timeframe. Historical calibration reproduces that rule by
    comparing bar *close* times. A higher-timeframe bar is therefore absent
    until its own close is less than or equal to the decision close.
    """
    decision_closes = (
        decisions["ts"].to_numpy(dtype="int64") + duration_ms(decision_timeframe)
    )
    source_closes = source["ts"].to_numpy(dtype="int64") + duration_ms(source_timeframe)
    return np.searchsorted(source_closes, decision_closes, side="right") - 1


def aligned_indicator_frames(
    frames: dict[str, pd.DataFrame],
    config: dict,
    decision_timeframe: str,
) -> tuple[list[dict], list[dict[str, int | None]]]:
    """Live-shaped score inputs aligned to historical decision closes.

    Only enabled indicators are included, exactly like ``ScreenerService``.
    The source-index sidecar lets the S&R slow path use the same aligned bar
    without duplicating the alignment rule.
    """
    decisions = frames[decision_timeframe]
    enabled = {
        name: spec for name, spec in config["indicators"].items() if spec["enabled"]
    }
    needed_timeframes = {spec["timeframe"] for spec in enabled.values()}
    computed = {
        tf: indicator_frames(frames[tf], config)
        for tf in needed_timeframes
        if tf in frames and not frames[tf].empty
    }
    aligned = {
        tf: source_bar_indices(decisions, frames[tf], decision_timeframe, tf)
        for tf in computed
    }

    payloads: list[dict] = []
    sources: list[dict[str, int | None]] = []
    for decision_index in range(len(decisions)):
        payload: dict[str, Any] = {}
        source_map: dict[str, int | None] = {}
        for name, spec in enabled.items():
            tf = spec["timeframe"]
            indices = aligned.get(tf)
            source_index = None if indices is None else int(indices[decision_index])
            if source_index is None or source_index < 0:
                source_map[name] = None
                continue
            source_map[name] = source_index
            value = computed[tf][source_index].get(name)
            if value is not None:
                payload[name] = value
        payloads.append(payload)
        sources.append(source_map)
    return payloads, sources


# --- the walk ---------------------------------------------------------


def walk_scores(
    data: pd.DataFrame | dict[str, pd.DataFrame],
    config: dict,
    start: int,
    stride: int = 1,
    with_sr: bool = True,
    timeframe: str | None = None,
) -> tuple[list[int], list[float]]:
    """Confluence score at each closed bar from `start` onward.

    Indicators see only data up to and including the bar being scored, which the
    series equivalence in `tests/test_no_lookahead.py` guarantees. S&R is the one
    exception: it has no series form, so it is genuinely recomputed on
    `df.iloc[:i+1]` and costs about 8ms a bar. Turning it off is faster and
    scores a different model, so the calibration records which was used.
    """
    if isinstance(data, pd.DataFrame):
        if timeframe is None:
            raise ValueError("timeframe is required when calibrating one dataframe")
        source_frames = {timeframe: data}
    else:
        source_frames = data
    if timeframe is None:
        raise ValueError("decision timeframe is required")

    df = source_frames[timeframe]
    payloads, source_indices = aligned_indicator_frames(source_frames, config, timeframe)
    sr_spec = config["indicators"]["sr"]
    include_sr = bool(with_sr and sr_spec["enabled"])
    sr_params = sr_spec.get("params") if include_sr else None
    sr_timeframe = sr_spec["timeframe"]
    sr_df = source_frames.get(sr_timeframe)
    sr_cache: dict[int, dict | None] = {}
    scoring_params = config.get("scoring")

    indices: list[int] = []
    scores: list[float] = []

    for i in range(start, len(df), stride):
        payload = dict(payloads[i])
        if include_sr and sr_df is not None:
            source_index = source_indices[i].get("sr")
            if source_index is not None and source_index not in sr_cache:
                try:
                    sr_cache[source_index] = sr_mod.compute(
                        sr_df.iloc[: source_index + 1], sr_params
                    )
                except Exception:
                    sr_cache[source_index] = None
            if source_index is not None and sr_cache.get(source_index) is not None:
                payload["sr"] = sr_cache[source_index]
            else:
                payload.pop("sr", None)
        else:
            payload.pop("sr", None)

        result = compute_score(payload, scoring_params)
        if result["score"] is None:
            continue
        indices.append(i)
        scores.append(float(result["score"]))

    return indices, scores


def _warmup_bars(config: dict) -> int:
    """First bar at which every enabled indicator has a value."""
    params = {k: v.get("params", {}) for k, v in config["indicators"].items()}
    enabled = config["indicators"]
    needs = [1]
    if enabled["ema"]["enabled"]:
        needs.append(max(int(x) for x in params.get("ema", {}).get("lengths", [200])) + 1)
    if enabled["adx"]["enabled"]:
        needs.append(
            int(params.get("adx", {}).get("adxLen", 14))
            + int(params.get("adx", {}).get("diLen", 14))
            + 2
        )
    if enabled["vfi"]["enabled"]:
        needs.append(
            2 * int(params.get("vfi", {}).get("length", 130))
            + int(params.get("vfi", {}).get("signalLength", 5))
            + 2
        )
    if enabled["sr"]["enabled"]:
        needs.append(
            2 * int(params.get("sr", {}).get("pivot_length", 15))
            + int(params.get("sr", {}).get("atr_length", 20))
            + 2
        )
    return max(needs)


def calibration_provenance(
    config: dict,
    symbol: str,
    timeframe: str,
    *,
    exchange: str | None = None,
    native_symbol: str | None = None,
    params: dict | None = None,
    with_sr: bool = True,
) -> dict:
    """Canonical inputs that determine one empirical calibration."""
    empirical = config.get("scoring", {}).get("empirical") or {}
    settings = {**DEFAULTS, **empirical, **(params or {})}
    settings.pop("enabled", None)  # presentation toggle; it changes no sample
    indicators = {
        name: {
            "timeframe": spec["timeframe"],
            "params": spec.get("params") or {},
        }
        for name, spec in config["indicators"].items()
        if spec["enabled"]
    }
    scoring = {
        key: value
        for key, value in (config.get("scoring") or {}).items()
        if key not in {"mode", "empirical"}
    }
    exchange_id = exchange or config.get("exchange")
    is_spot = exchange_id == "binance"
    market_type = (
        "spot" if is_spot
        else "usd_m_perpetual" if exchange_id == "binanceusdm"
        else "linear_perpetual"
    )
    return {
        "calculation_version": CALCULATION_VERSION,
        "market": {
            "exchange": exchange_id,
            "market_type": market_type,
            "contract_type": None if is_spot else "perpetual",
            "linear": not is_spot,
            "spot": is_spot,
        },
        "symbol": {
            "config": symbol,
            "native": native_symbol or symbol,
        },
        "decision_timeframe": timeframe,
        "indicator_basis": indicators,
        "scoring": scoring,
        "calibration_settings": settings,
        "with_sr": bool(with_sr and config["indicators"]["sr"]["enabled"]),
    }


def calibration_fingerprint(
    config: dict,
    symbol: str,
    timeframe: str,
    **kwargs: Any,
) -> tuple[str, dict]:
    provenance = calibration_provenance(config, symbol, timeframe, **kwargs)
    encoded = json.dumps(
        provenance, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest(), provenance


def assess_provenance(calibration: dict, expected_fingerprint: str) -> dict:
    """Return a presentation copy marked current or stale; never rewrite storage."""
    out = dict(calibration)
    stored = calibration.get("fingerprint")
    if stored == expected_fingerprint:
        out.update({"current": True, "stale": False, "stale_reason": None})
        return out

    reason = (
        "legacy calibration has no fingerprint"
        if not stored
        else "calibration fingerprint does not match current calculation settings"
    )
    out.update({
        "current": False,
        "stale": True,
        "stale_reason": reason,
        "historically_available": bool(calibration.get("available")),
        "available": False,
    })
    return out


@dataclass
class Decile:
    index: int
    score_lo: float
    score_hi: float
    n: int
    hits: int
    unresolved: int
    ambiguous: int

    @property
    def hit_rate(self) -> float | None:
        return self.hits / self.n if self.n else None

    def to_json(self, minimum: int) -> dict:
        """Display rules of §6.2, enforced here rather than trusted to the UI."""
        enough = self.n >= minimum
        return {
            "index": self.index,
            "score_lo": self.score_lo,
            "score_hi": self.score_hi,
            "n": self.n,
            "hits": self.hits,
            "unresolved": self.unresolved,
            "ambiguous": self.ambiguous,
            "sufficient": enough,
            # A rate is emitted only when the sample supports one. The string is
            # what the UI shows; there is deliberately no number to fall back to.
            "hit_rate": self.hit_rate if enough else None,
            "display": (
                f"{self.hit_rate * 100:.1f}% (n={self.n})" if enough and self.hit_rate is not None
                else f"{INSUFFICIENT} (n={self.n})"
            ),
        }


def calibrate(
    data: pd.DataFrame | dict[str, pd.DataFrame],
    config: dict,
    symbol: str,
    timeframe: str,
    params: dict | None = None,
    with_sr: bool = True,
    *,
    exchange: str | None = None,
    native_symbol: str | None = None,
) -> dict:
    """Score deciles with empirical hit rates, per symbol. §6.2."""
    p = {**DEFAULTS, **(config.get("scoring", {}).get("empirical") or {}), **(params or {})}
    p.pop("enabled", None)
    frames = {timeframe: data} if isinstance(data, pd.DataFrame) else data
    if timeframe not in frames:
        raise ValueError(f"missing decision timeframe {timeframe}")
    df = frames[timeframe]
    fingerprint, provenance = calibration_fingerprint(
        config,
        symbol,
        timeframe,
        exchange=exchange,
        native_symbol=native_symbol,
        params=params,
        with_sr=with_sr,
    )
    common = {
        "symbol": symbol,
        "timeframe": timeframe,
        "fingerprint": fingerprint,
        "provenance": provenance,
    }
    horizon = int(p["horizon_bars"])
    minimum = int(p["min_decile_samples"])
    n_deciles = int(p["deciles"])

    warmup = _warmup_bars(config)
    max_bars = int(p["max_bars"])
    start = max(warmup, len(df) - max_bars)
    # A bar cannot be labelled without `horizon` bars after it.
    last_labelable = len(df) - 1 - horizon

    warnings: list[str] = []
    if last_labelable <= start:
        return {
            **common, "available": False,
            "reason": (
                f"not enough history: need more than {warmup + horizon} bars, have {len(df)}"
            ),
            "warnings": warnings, "deciles": [], "samples": 0,
        }

    indices, scores = walk_scores(
        frames, config, start, with_sr=with_sr, timeframe=timeframe
    )

    high = df["high"].to_numpy(dtype="float64")
    low = df["low"].to_numpy(dtype="float64")
    close = df["close"].to_numpy(dtype="float64")
    atr = ta.atr(df, int(p["atr_length"])).to_numpy()

    kept_scores: list[float] = []
    outcomes: list[int | None] = []
    ambiguous_flags: list[bool] = []

    for i, score in zip(indices, scores):
        if i > last_labelable or not np.isfinite(atr[i]) or atr[i] <= 0:
            continue
        lab = label_bar(
            high, low, float(close[i]), float(atr[i]), i, horizon,
            float(p["target_atr"]), float(p["stop_atr"]),
        )
        kept_scores.append(score)
        outcomes.append(lab.outcome)
        ambiguous_flags.append(lab.ambiguous)

    if not kept_scores:
        return {
            **common, "available": False,
            "reason": "no labelable bars", "warnings": warnings,
            "deciles": [], "samples": 0,
        }

    arr = np.array(kept_scores)
    # Equal-count deciles, not equal-width bins: "deciles" means quantiles, and
    # fixed-width bins would leave the extreme buckets nearly empty.
    edges = np.unique(np.quantile(arr, np.linspace(0.0, 1.0, n_deciles + 1)))
    assignments = np.clip(np.searchsorted(edges, arr, side="right") - 1, 0, len(edges) - 2)

    deciles: list[Decile] = []
    for d in range(len(edges) - 1):
        mask = assignments == d
        resolved = [o for o, m in zip(outcomes, mask) if m and o is not None]
        unresolved = sum(1 for o, m in zip(outcomes, mask) if m and o is None)
        ambiguous = sum(1 for a, m in zip(ambiguous_flags, mask) if m and a)
        deciles.append(Decile(
            index=d,
            score_lo=float(edges[d]),
            score_hi=float(edges[d + 1]),
            n=len(resolved),
            hits=sum(resolved),
            unresolved=unresolved,
            ambiguous=ambiguous,
        ))

    start_ts = int(df["ts"].iloc[indices[0]]) if indices else None
    end_ts = int(df["ts"].iloc[-1])
    days = (end_ts - start_ts) / DAY_MS if start_ts else 0.0

    if days < float(p["min_window_days"]):
        warnings.append(
            f"calibration window is {days:.0f} days — under six months. "
            f"Rates from a window this short describe one market regime, not a general edge."
        )
    if any(d.n < minimum for d in deciles):
        thin = [d.index for d in deciles if d.n < minimum]
        warnings.append(
            f"decile(s) {thin} have fewer than {minimum} resolved samples and report "
            f"'{INSUFFICIENT}' instead of a rate."
        )
    warnings.append(
        f"samples overlap: each observation shares up to {horizon - 1} bars with its "
        f"neighbour, so n counts observations, not independent ones."
    )
    if not with_sr:
        warnings.append("S&R was excluded from the walk — this calibrates a different model.")

    total_unresolved = sum(d.unresolved for d in deciles)
    total_ambiguous = sum(d.ambiguous for d in deciles)

    # If no decile cleared the sample threshold there is nothing usable here.
    # Reporting `available: True` with ten "insufficient data" rows invites the
    # reader to squint at rates that the code has already refused to publish.
    usable = any(d.n >= minimum for d in deciles)
    reason = None if usable else (
        f"no decile reached {minimum} resolved samples "
        f"({len(kept_scores)} labelled bars across {len(deciles)} deciles)"
    )

    return {
        **common,
        "available": usable,
        "reason": reason,
        "in_sample": True,
        "settings": {
            "horizon_bars": horizon,
            "target_atr": float(p["target_atr"]),
            "stop_atr": float(p["stop_atr"]),
            "min_decile_samples": minimum,
            "with_sr": with_sr,
        },
        "window": {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "days": round(days, 1),
            "bars": len(kept_scores),
        },
        "samples": len(kept_scores),
        "resolved": sum(1 for o in outcomes if o is not None),
        "unresolved": total_unresolved,
        "ambiguous": total_ambiguous,
        "base_rate": (
            sum(o for o in outcomes if o is not None) / max(1, sum(1 for o in outcomes if o is not None))
        ),
        "deciles": [d.to_json(minimum) for d in deciles],
        "warnings": warnings,
    }


def lookup(
    calibration: dict,
    score: float | None,
    expected_fingerprint: str | None = None,
) -> dict:
    """The decile the live score falls into. §6.2 step 4.

    `n` travels with every answer, including the refusals: "insufficient data"
    with no number attached hides how far short the sample fell, which is the
    thing a reader most needs in order to judge it.
    """
    stored_fingerprint = calibration.get("fingerprint")
    if not stored_fingerprint or (
        expected_fingerprint is not None and stored_fingerprint != expected_fingerprint
    ):
        reason = (
            "legacy calibration has no fingerprint"
            if not stored_fingerprint
            else "calibration fingerprint does not match current calculation settings"
        )
        return {
            "available": False,
            "current": False,
            "stale": True,
            "stale_reason": reason,
            "display": f"{INSUFFICIENT} (n=0) — stale calibration: {reason}",
            "hit_rate": None,
            "n": 0,
        }

    if score is None:
        return {"available": False, "display": f"{INSUFFICIENT} (no score)",
                "hit_rate": None, "n": 0}

    deciles = calibration.get("deciles") or []
    match = next(
        (d for d in deciles if d["score_lo"] <= score <= d["score_hi"]),
        None,
    )

    if match is None:
        return {
            "available": False,
            "hit_rate": None,
            "n": 0,
            "display": f"{INSUFFICIENT} (score outside the calibrated range)",
        }

    if not calibration.get("available"):
        reason = calibration.get("reason") or "calibration unusable"
        return {
            "available": False,
            "decile": match["index"],
            "hit_rate": None,
            "n": match["n"],
            "display": f"{INSUFFICIENT} (n={match['n']}) — {reason}",
        }

    return {
        "available": match["sufficient"],
        "decile": match["index"],
        "hit_rate": match["hit_rate"],
        "n": match["n"],
        "display": match["display"],
    }
