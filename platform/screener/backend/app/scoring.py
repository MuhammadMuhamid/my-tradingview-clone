"""Confluence score — §6.1.

**This is a score, not a probability.** It has not been validated against forward
returns. Nothing in this module may be labelled or formatted as a percentage
chance of anything; the empirical mode of §6.2 is the only thing allowed to use
the word "probability", and it has to earn it with a forward-return sample size.

The problem this design exists to solve: EMA distance, Supertrend, ADX direction
and MACD are all transforms of the same close series. Summing them as eight
independent votes manufactures confluence — one trend move gets counted four
times and the score saturates at 90+ on what is really a single signal.

So inputs are **bucketed**, and each bucket casts one capped vote:

| Bucket   | Inputs                                                  | Weight |
|----------|---------------------------------------------------------|--------|
| Trend    | EMA stack, EMA dist_atr set, Supertrend dir + maturity   | 30     |
| Momentum | RSI level and slope, MACD hist + bars_since_cross        | 25     |
| Volume   | VFI vs zero, VFI vs signal, VFI slope                    | 20     |
| Location | S&R position_in_range, support/resistance ATR distances  | 15     |
| Trigger  | Candle net_bias x strength, only if bars_ago <= 2        | 10     |

ADX is **not** a sixth vote. It is a gate: in a ranging regime the Trend and
Trigger buckets are scaled down, because trend signals read in chop are the main
source of false positives.

Every bucket produces a signed sub-score in [-1, +1] and every sub-score, along
with the raw components behind it, is returned for display. A single number with
no breakdown is unauditable.
"""

from __future__ import annotations

import math
from typing import Any

LABEL = "Confluence Score"
DISCLAIMER = (
    "A weighted confluence score, not a probability. "
    "It has not been validated against forward returns."
)

DEFAULTS: dict[str, Any] = {
    "weights": {"trend": 30, "momentum": 25, "volume": 20, "location": 15, "trigger": 10},
    # §6.1: ADX < 20 scales the Trend and Trigger buckets. Exposed, as required.
    "ranging_multiplier": 0.5,
    "transitional_multiplier": 1.0,
    "trending_multiplier": 1.0,
    # The spec names DI direction as a gate input but only specifies the regime
    # behaviour. This is the hook for it, defaulted to 1.0 so the shipped
    # behaviour is exactly what §6.1 describes. Set below 1.0 to penalise a
    # trend bucket that disagrees with DI dominance.
    "di_conflict_multiplier": 1.0,
    # Saturation scales. Each maps a raw indicator value onto [-1, +1] via tanh,
    # so no single extreme reading can dominate its bucket.
    "ema_dist_atr_scale": 2.0,
    "rsi_span": 20.0,          # RSI 30..70 maps to -1..+1
    "rsi_slope_scale": 5.0,
    "macd_hist_atr_scale": 0.5,
    "macd_stale_bars": 30,     # a cross this old contributes only `macd_stale_floor`
    "macd_stale_floor": 0.2,
    "supertrend_maturity_bars": 10,
    "supertrend_fresh_weight": 0.5,
    "vfi_scale": 2.0,
    "vfi_slope_scale": 1.0,
    # ATR distance at which a level stops carrying much locational meaning.
    "location_proximity_atr": 3.0,
    "trigger_max_bars_ago": 2,
}

BUCKETS = ("trend", "momentum", "volume", "location", "trigger")
GATED_BUCKETS = ("trend", "trigger")


def _tanh(value: float, scale: float) -> float:
    """Squash onto (-1, 1). `scale` is the value at which the output is ~0.76."""
    if scale <= 0:
        return 0.0
    return math.tanh(value / scale)


def _clip(value: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _mean(components: dict[str, float | None]) -> tuple[float | None, dict[str, float]]:
    """Average the components that exist. A bucket with none is unavailable."""
    present = {k: v for k, v in components.items() if v is not None}
    if not present:
        return None, {}
    return _clip(sum(present.values()) / len(present)), present


def _num(source: dict | None, key: str) -> float | None:
    if not source:
        return None
    value = source.get(key)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# --- buckets ----------------------------------------------------------


def _trend(ind: dict, p: dict) -> tuple[float | None, dict[str, float]]:
    ema, st = ind.get("ema"), ind.get("supertrend")
    components: dict[str, float | None] = {}

    stack = (ema or {}).get("stack")
    components["ema_stack"] = {"bull": 1.0, "bear": -1.0, "mixed": 0.0}.get(stack)  # type: ignore[arg-type]

    distances = [_num(ema, f"dist_atr_{n}") for n in (21, 50, 100, 200)]
    present = [d for d in distances if d is not None]
    components["ema_distance"] = (
        _clip(sum(_tanh(d, float(p["ema_dist_atr_scale"])) for d in present) / len(present))
        if present else None
    )

    direction = _num(st, "direction")
    if direction is None:
        components["supertrend"] = None
    else:
        # A direction that has held for a while is trend structure. One that
        # flipped on this bar is barely evidence yet, so it is discounted until
        # it matures — the flip itself belongs to the Trigger bucket, not here.
        bars = _num(st, "bars_since_flip")
        maturity = float(p["supertrend_maturity_bars"])
        fresh = float(p["supertrend_fresh_weight"])
        ramp = 1.0 if bars is None or maturity <= 0 else fresh + (1.0 - fresh) * _clip(bars / maturity, 0.0, 1.0)
        components["supertrend"] = _clip(direction * ramp)

    return _mean(components)


def _momentum(ind: dict, p: dict) -> tuple[float | None, dict[str, float]]:
    rsi, macd, ema = ind.get("rsi"), ind.get("macd"), ind.get("ema")
    components: dict[str, float | None] = {}

    level = _num(rsi, "rsi")
    components["rsi_level"] = None if level is None else _clip((level - 50.0) / float(p["rsi_span"]))

    slope = _num(rsi, "slope")
    components["rsi_slope"] = None if slope is None else _tanh(slope, float(p["rsi_slope_scale"]))

    hist = _num(macd, "hist")
    atr = _num(ema, "atr")
    if hist is None or not atr:
        components["macd"] = None
    else:
        # MACD histogram is price-scaled, so it is normalised by ATR before it
        # can be compared across coins at all.
        magnitude = _tanh(hist / atr, float(p["macd_hist_atr_scale"]))
        bars = _num(macd, "bars_since_cross")
        stale = float(p["macd_stale_bars"])
        floor = float(p["macd_stale_floor"])
        # "A cross 30 bars ago is not a signal" — decay it, but not to zero: an
        # old cross still describes which side of the signal line price sits on.
        recency = 1.0 if bars is None or stale <= 0 else max(floor, 1.0 - bars / stale)
        components["macd"] = _clip(magnitude * recency)

    return _mean(components)


def _volume(ind: dict, p: dict) -> tuple[float | None, dict[str, float]]:
    vfi = ind.get("vfi")
    scale = float(p["vfi_scale"])
    value = _num(vfi, "vfi")
    hist = _num(vfi, "hist")
    slope = _num(vfi, "slope")

    return _mean({
        "vfi_vs_zero": None if value is None else _tanh(value, scale),
        "vfi_vs_signal": None if hist is None else _tanh(hist, scale),
        "vfi_slope": None if slope is None else _tanh(slope, float(p["vfi_slope_scale"])),
    })


def _location(ind: dict, p: dict) -> tuple[float | None, dict[str, float]]:
    """Near support is bullish, near resistance is bearish — scaled by conviction.

    A subtle trap here, found by inspecting the breakdown: the obvious second
    component, `(d_res - d_sup) / (d_res + d_sup)`, is not a second opinion at
    all. Expand it — `d_sup = (close - sup)/atr` and `d_res = (res - close)/atr`,
    so the ratio reduces to `1 - 2 * position_in_range` exactly. Averaging the
    two would have shown one number twice and looked like two confirmations,
    which is precisely the fake-confluence failure §6.1 exists to prevent.

    So the ATR distances are used for something `position_in_range` genuinely
    cannot express: **conviction**. Sitting 0.2 ATR off support is a strong
    location read; sitting at the same relative position inside a range six ATR
    wide is barely a location read at all. Direction comes from the position,
    magnitude from the absolute proximity to the nearer level.
    """
    sr = ind.get("sr")

    position = _num(sr, "position_in_range")
    direction = None if position is None else _clip(1.0 - 2.0 * position)

    to_sup = _num(sr, "dist_to_support_atr")
    to_res = _num(sr, "dist_to_resistance_atr")
    nearest = min(d for d in (to_sup, to_res) if d is not None) if (to_sup is not None or to_res is not None) else None
    conviction = None if nearest is None else math.exp(-max(nearest, 0.0) / float(p["location_proximity_atr"]))

    if direction is None:
        return _mean({"position_in_range": None})

    components: dict[str, float | None] = {
        "position_in_range": direction,
        "proximity_conviction": conviction,
    }
    if conviction is None:
        return _mean({"position_in_range": direction})

    # One vote, not two: conviction scales the direction rather than averaging
    # against it.
    score = _clip(direction * conviction)
    return score, {k: v for k, v in components.items() if v is not None}


def _trigger(ind: dict, p: dict) -> tuple[float | None, dict[str, float]]:
    candles = ind.get("candles") or {}
    bias = candles.get("net_bias")
    patterns = candles.get("patterns") or []
    max_bars = int(p["trigger_max_bars_ago"])

    if bias not in ("bull", "bear") or not patterns:
        return _mean({"candle": 0.0 if candles else None})

    # The strength of the pattern that produced the bias, on the bar that
    # produced it. Anything older than `trigger_max_bars_ago` is not a trigger.
    newest = min(int(x.get("bars_ago", 0)) for x in patterns)
    if newest > max_bars:
        return _mean({"candle": 0.0})

    driving = [
        float(x.get("strength", 0.0))
        for x in patterns
        if int(x.get("bars_ago", 0)) == newest and x.get("direction") == bias
    ]
    strength = max(driving) if driving else 0.0
    return _mean({"candle": _clip((1.0 if bias == "bull" else -1.0) * strength)})


_BUCKET_FNS = {
    "trend": _trend,
    "momentum": _momentum,
    "volume": _volume,
    "location": _location,
    "trigger": _trigger,
}


# --- gate and assembly ------------------------------------------------


def _gate(ind: dict, p: dict, trend_score: float | None) -> dict:
    """ADX as a multiplier on Trend and Trigger, never as an additive vote."""
    adx = ind.get("adx") or {}
    regime = adx.get("regime")
    direction = adx.get("direction")

    multiplier = {
        "ranging": float(p["ranging_multiplier"]),
        "transitional": float(p["transitional_multiplier"]),
        "trending": float(p["trending_multiplier"]),
    }.get(regime, 1.0)  # type: ignore[arg-type]

    conflict = False
    if direction in ("bull", "bear") and trend_score is not None and trend_score != 0.0:
        conflict = (direction == "bull") != (trend_score > 0)
        if conflict:
            multiplier *= float(p["di_conflict_multiplier"])

    return {
        "regime": regime,
        "di_direction": direction,
        "di_conflicts_with_trend": conflict,
        "multiplier": multiplier,
        "applies_to": list(GATED_BUCKETS),
    }


def compute(indicators: dict, params: dict | None = None) -> dict:
    """Score one row. `indicators` is the row's `{name: result}` mapping."""
    p = {**DEFAULTS, **(params or {})}
    weights = {**DEFAULTS["weights"], **(p.get("weights") or {})}

    sub_scores: dict[str, float | None] = {}
    breakdown: dict[str, dict] = {}

    for name in BUCKETS:
        score, components = _BUCKET_FNS[name](indicators, p)
        sub_scores[name] = score
        breakdown[name] = {
            "sub_score": score,
            "weight": weights[name],
            "components": components,
            "available": score is not None,
        }

    gate = _gate(indicators, p, sub_scores["trend"])

    total = 0.0
    total_weight = 0.0
    for name in BUCKETS:
        score = sub_scores[name]
        if score is None:
            breakdown[name]["effective_weight"] = 0.0
            breakdown[name]["contribution"] = None
            continue
        effective = weights[name] * (gate["multiplier"] if name in GATED_BUCKETS else 1.0)
        breakdown[name]["effective_weight"] = effective
        breakdown[name]["contribution"] = effective * score
        total += effective * score
        total_weight += effective

    if total_weight <= 0:
        return {
            "label": LABEL,
            "disclaimer": DISCLAIMER,
            "score": None,
            "signed": None,
            "coverage": 0.0,
            "gate": gate,
            "buckets": breakdown,
            "note": "no bucket had usable inputs",
        }

    # Weights are renormalised over the buckets that actually had data. Without
    # this, disabling one indicator would silently drag every score toward
    # neutral and look like a market-wide change rather than a config change.
    signed = _clip(total / total_weight) * 100.0
    nominal = sum(weights[b] for b in BUCKETS)
    covered = sum(weights[b] for b in BUCKETS if sub_scores[b] is not None)

    return {
        "label": LABEL,
        "disclaimer": DISCLAIMER,
        # Displayed 0-100 as a long bias: 50 is neutral, not "50% chance".
        "score": (signed + 100.0) / 2.0,
        "signed": signed,
        "coverage": covered / nominal if nominal else 0.0,
        "gate": gate,
        "buckets": breakdown,
        "note": None,
    }
