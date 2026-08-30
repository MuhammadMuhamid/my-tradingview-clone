"""MTF 1h + 15m + 5m scalping strategy — a rule checklist, evaluated both ways.

Each timeframe carries a list of conditions. Every condition is evaluated for a
**bullish** reading and, as its mirror, a **bearish** one, so the same screen
answers "is this setting up long?" and "is this setting up short?" side by side.

## What the percentages mean, and what they do not

`bullish_pct` is **the fraction of the checklist that passes**. Six of seven
conditions met is 85.7%. That is a count of facts about the current bar, and it
is the only percentage here that is computed rather than estimated.

It is **not** a probability, and it is not the confluence score. It says nothing
about what price does next. A setup can satisfy every rule and lose; that is what
`app/calibration.py` exists to measure, and what it measured was no monotonic
relationship between score and forward outcome on the window tested.

Rules marked `required=False` are reported but excluded from the percentage, so
an optional condition cannot pad the count. The 1h Supertrend rule is the only
one: the user's spec says it "must be bullish and can be bearish also", i.e. it
is informational on that timeframe rather than a gate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

Ctx = dict[str, Any]
Predicate = Callable[[Ctx, dict], "bool | None"]

BULL, BEAR = "bull", "bear"


def _get(ctx: Ctx, indicator: str, field_name: str) -> Any:
    block = ctx.get(indicator)
    return None if not isinstance(block, dict) else block.get(field_name)


def _num(ctx: Ctx, indicator: str, field_name: str) -> float | None:
    value = _get(ctx, indicator, field_name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


@dataclass(frozen=True)
class Rule:
    id: str
    label: str
    bull: Predicate
    bear: Predicate
    detail: Callable[[Ctx, dict], str] | None = None
    required: bool = True
    note: str | None = None

    def evaluate(self, ctx: Ctx, params: dict, side: str) -> dict:
        fn = self.bull if side == BULL else self.bear
        try:
            passed = fn(ctx, params)
        except Exception as exc:  # a broken rule must not take the row down
            return {
                "id": self.id, "label": self.label, "passed": None,
                "required": self.required, "detail": f"error: {exc}", "note": self.note,
            }
        return {
            "id": self.id,
            "label": self.label,
            "passed": passed,
            "required": self.required,
            "detail": self.detail(ctx, params) if self.detail else None,
            "note": self.note,
        }


# --- shared predicates -------------------------------------------------


def _stack(direction: str) -> Predicate:
    def check(ctx: Ctx, _p: dict) -> bool | None:
        value = _get(ctx, "ema", "stack")
        return None if value is None else value == direction
    return check


def _rsi_above(above: bool) -> Predicate:
    def check(ctx: Ctx, p: dict) -> bool | None:
        value = _num(ctx, "rsi", "rsi")
        level = float(p.get("rsi_level", 50.0))
        return None if value is None else (value > level if above else value < level)
    return check


def _macd_zero(above: bool) -> Predicate:
    def check(ctx: Ctx, _p: dict) -> bool | None:
        value = _num(ctx, "macd", "macd")
        return None if value is None else (value > 0.0 if above else value < 0.0)
    return check


def _supertrend(direction: int) -> Predicate:
    def check(ctx: Ctx, _p: dict) -> bool | None:
        value = _num(ctx, "supertrend", "direction")
        return None if value is None else int(value) == direction
    return check


def _adx_di(side: str) -> Predicate:
    """ADX above the threshold *and* the matching DI above it."""
    def check(ctx: Ctx, p: dict) -> bool | None:
        adx = _num(ctx, "adx", "adx")
        di = _num(ctx, "adx", "plus_di" if side == BULL else "minus_di")
        threshold = float(p.get("adx_level", 20.0))
        if adx is None or di is None:
            return None
        return adx > threshold and di > threshold
    return check


def _touching_any_ema(ctx: Ctx, p: dict) -> bool | None:
    """Close is within `ema_touch_atr` of any of the four EMAs.

    "Touching" needs a tolerance: price equalling an EMA to the tick effectively
    never happens, so the test is proximity in ATR, which is comparable across
    coins in a way a percentage is not.
    """
    tolerance = float(p.get("ema_touch_atr", 0.25))
    distances = [
        _num(ctx, "ema", f"dist_atr_{n}") for n in p.get("ema_lengths", [21, 50, 100, 200])
    ]
    present = [d for d in distances if d is not None]
    if not present:
        return None
    return any(abs(d) <= tolerance for d in present)


def _above_ema(length: int, above: bool) -> Predicate:
    def check(ctx: Ctx, _p: dict) -> bool | None:
        distance = _num(ctx, "ema", f"dist_atr_{length}")
        return None if distance is None else (distance > 0 if above else distance < 0)
    return check


def _at_level(side: str) -> Predicate:
    """Price sitting on an S&R level or a Pivot Points Standard level.

    Either source qualifies: the user's rule says "a support level **or** pivot
    point standard fib level".
    """
    def check(ctx: Ctx, p: dict) -> bool | None:
        tolerance = float(p.get("level_touch_atr", 0.5))

        sr_dist = _num(ctx, "sr", "dist_to_support_atr" if side == BULL else "dist_to_resistance_atr")
        on_sr = sr_dist is not None and abs(sr_dist) <= tolerance

        pivot_dist = _num(ctx, "pivots", "nearest_dist_atr")
        pivot_name = _get(ctx, "pivots", "nearest")
        on_pivot = False
        if pivot_dist is not None and abs(pivot_dist) <= tolerance and isinstance(pivot_name, str):
            # A long wants to be on a support-side pivot (S1-S3 or P), a short on
            # a resistance-side one (R1-R5 or P).
            on_pivot = pivot_name.startswith("S" if side == BULL else "R") or pivot_name.strip() == "P"

        if sr_dist is None and pivot_dist is None:
            return None
        return on_sr or on_pivot
    return check


def _vfi_cross(side: str) -> Predicate:
    """VFI crossed its signal line in the given direction, recently."""
    def check(ctx: Ctx, p: dict) -> bool | None:
        field_name = "bars_since_cross_up" if side == BULL else "bars_since_cross_down"
        bars = _get(ctx, "vfi", field_name)
        above = _get(ctx, "vfi", "above_signal")
        if bars is None or above is None:
            return None
        max_bars = int(p.get("vfi_cross_max_bars", 5))
        standing = above if side == BULL else not above
        return standing and int(bars) <= max_bars
    return check


def _vwap(above: bool) -> Predicate:
    def check(ctx: Ctx, _p: dict) -> bool | None:
        value = _get(ctx, "vwap", "above_vwap")
        return None if value is None else (bool(value) is above)
    return check


# --- detail renderers --------------------------------------------------


def _d(text: str) -> Callable[[Ctx, dict], str]:
    return lambda ctx, p: text


def _fmt(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


# --- the rule sets -----------------------------------------------------

RULES: dict[str, list[Rule]] = {
    "1h": [
        Rule("ema_stack", "EMA structure stacked (21>50>100>200)",
             _stack("bull"), _stack("bear"),
             detail=lambda c, p: f"stack={_get(c, 'ema', 'stack')}"),
        Rule("rsi_50", "RSI(50) above the 50 level",
             _rsi_above(True), _rsi_above(False),
             detail=lambda c, p: f"rsi={_fmt(_num(c, 'rsi', 'rsi'), 1)}"),
        Rule("at_ema", "Close touching the 21 / 50 / 100 / 200 EMA",
             _touching_any_ema, _touching_any_ema,
             detail=lambda c, p: "nearest "
                                 f"{_get(c, 'ema', 'nearest_ema')} EMA at "
                                 f"{_fmt(_num(c, 'ema', f'dist_atr_{_get(c, 'ema', 'nearest_ema')}'))} ATR"),
        Rule("supertrend", "Supertrend direction",
             _supertrend(1), _supertrend(-1), required=False,
             note="Informational on 1h — your spec allows either direction here.",
             detail=lambda c, p: f"dir={_num(c, 'supertrend', 'direction')}"),
        Rule("at_level", "Close on a support / pivot fib level",
             _at_level(BULL), _at_level(BEAR),
             detail=lambda c, p: f"pivot {_get(c, 'pivots', 'nearest')} at "
                                 f"{_fmt(_num(c, 'pivots', 'nearest_dist_atr'))} ATR"),
        Rule("adx_di", "ADX and directional DI above 20",
             _adx_di(BULL), _adx_di(BEAR),
             detail=lambda c, p: f"adx={_fmt(_num(c, 'adx', 'adx'), 1)} "
                                 f"+DI={_fmt(_num(c, 'adx', 'plus_di'), 1)} "
                                 f"-DI={_fmt(_num(c, 'adx', 'minus_di'), 1)}"),
        Rule("macd_zero", "MACD line the right side of zero",
             _macd_zero(True), _macd_zero(False),
             detail=lambda c, p: f"macd={_fmt(_num(c, 'macd', 'macd'), 4)}"),
    ],
    "15m": [
        Rule("ema_stack", "EMA structure stacked (21>50>100>200)",
             _stack("bull"), _stack("bear"),
             detail=lambda c, p: f"stack={_get(c, 'ema', 'stack')}"),
        Rule("ema_200_side", "Close the right side of the 200 EMA",
             _above_ema(200, True), _above_ema(200, False),
             detail=lambda c, p: f"{_fmt(_num(c, 'ema', 'dist_atr_200'))} ATR from the 200"),
        Rule("rsi_50", "RSI(50) above the 50 level",
             _rsi_above(True), _rsi_above(False),
             detail=lambda c, p: f"rsi={_fmt(_num(c, 'rsi', 'rsi'), 1)}"),
        Rule("supertrend", "Supertrend aligned",
             _supertrend(1), _supertrend(-1),
             detail=lambda c, p: f"dir={_num(c, 'supertrend', 'direction')}"),
        Rule("at_level", "Close on a support / pivot fib level",
             _at_level(BULL), _at_level(BEAR),
             detail=lambda c, p: f"pivot {_get(c, 'pivots', 'nearest')} at "
                                 f"{_fmt(_num(c, 'pivots', 'nearest_dist_atr'))} ATR"),
        Rule("adx_di", "ADX and directional DI above 20",
             _adx_di(BULL), _adx_di(BEAR),
             detail=lambda c, p: f"adx={_fmt(_num(c, 'adx', 'adx'), 1)} "
                                 f"+DI={_fmt(_num(c, 'adx', 'plus_di'), 1)} "
                                 f"-DI={_fmt(_num(c, 'adx', 'minus_di'), 1)}"),
        Rule("macd_zero", "MACD line the right side of zero",
             _macd_zero(True), _macd_zero(False),
             detail=lambda c, p: f"macd={_fmt(_num(c, 'macd', 'macd'), 4)}"),
    ],
    "5m": [
        Rule("ema_200_side", "Close the right side of the 200 EMA",
             _above_ema(200, True), _above_ema(200, False),
             detail=lambda c, p: f"{_fmt(_num(c, 'ema', 'dist_atr_200'))} ATR from the 200"),
        Rule("rsi_50", "RSI(50) above the 50 level",
             _rsi_above(True), _rsi_above(False),
             detail=lambda c, p: f"rsi={_fmt(_num(c, 'rsi', 'rsi'), 1)}"),
        Rule("vfi_cross", "VFI crossed its signal line the right way",
             _vfi_cross(BULL), _vfi_cross(BEAR),
             detail=lambda c, p: f"vfi={_fmt(_num(c, 'vfi', 'vfi'), 3)} "
                                 f"signal={_fmt(_num(c, 'vfi', 'vfima'), 3)} "
                                 f"{_get(c, 'vfi', 'bars_since_cross_up')} bars since cross up"),
        Rule("supertrend", "Supertrend aligned",
             _supertrend(1), _supertrend(-1),
             detail=lambda c, p: f"dir={_num(c, 'supertrend', 'direction')}"),
        Rule("adx_di", "ADX and directional DI above 20",
             _adx_di(BULL), _adx_di(BEAR),
             detail=lambda c, p: f"adx={_fmt(_num(c, 'adx', 'adx'), 1)} "
                                 f"+DI={_fmt(_num(c, 'adx', 'plus_di'), 1)} "
                                 f"-DI={_fmt(_num(c, 'adx', 'minus_di'), 1)}"),
        Rule("vwap_side", "Close the right side of VWAP",
             _vwap(True), _vwap(False),
             detail=lambda c, p: f"vwap={_fmt(_num(c, 'vwap', 'vwap'), 4)} "
                                 f"({_fmt(_num(c, 'vwap', 'dist_atr'))} ATR)"),
        Rule("macd_zero", "MACD line the right side of zero",
             _macd_zero(True), _macd_zero(False),
             detail=lambda c, p: f"macd={_fmt(_num(c, 'macd', 'macd'), 4)}"),
    ],
}

TIMEFRAME_ORDER = ("1h", "15m", "5m")

DEFAULTS: dict[str, Any] = {
    "timeframes": {"htf": "1h", "mtf": "15m", "ltf": "5m"},
    "rsi_level": 50.0,
    "adx_level": 20.0,
    "ema_touch_atr": 0.25,
    "level_touch_atr": 0.5,
    "vfi_cross_max_bars": 5,
    "ema_lengths": [21, 50, 100, 200],
}


def evaluate_side(contexts: dict[str, Ctx], params: dict, side: str) -> dict:
    """Run every rule on every timeframe for one direction."""
    per_tf: dict[str, dict] = {}
    passed_total = 0
    required_total = 0

    for slot, rules in RULES.items():
        ctx = contexts.get(slot) or {}
        results = [rule.evaluate(ctx, params, side) for rule in rules]
        required = [r for r in results if r["required"]]
        hits = sum(1 for r in required if r["passed"] is True)

        passed_total += hits
        required_total += len(required)

        per_tf[slot] = {
            "rules": results,
            "passed": hits,
            "total": len(required),
            "pct": round(hits / len(required) * 100.0, 1) if required else None,
            "all": hits == len(required) and len(required) > 0,
            "unknown": sum(1 for r in results if r["passed"] is None),
        }

    return {
        "side": side,
        "timeframes": per_tf,
        "passed": passed_total,
        "total": required_total,
        "pct": round(passed_total / required_total * 100.0, 1) if required_total else None,
        # Every required rule on all three timeframes. This is the setup the
        # strategy actually describes; anything less is a partial.
        "aligned": all(tf["all"] for tf in per_tf.values()),
    }


def evaluate(contexts: dict[str, Ctx], params: dict | None = None) -> dict:
    """Both directions, plus the net read."""
    p = {**DEFAULTS, **(params or {})}
    bull = evaluate_side(contexts, p, BULL)
    bear = evaluate_side(contexts, p, BEAR)

    bias = "none"
    if bull["aligned"] and not bear["aligned"]:
        bias = BULL
    elif bear["aligned"] and not bull["aligned"]:
        bias = BEAR
    elif bull["pct"] is not None and bear["pct"] is not None and bull["pct"] != bear["pct"]:
        bias = BULL if bull["pct"] > bear["pct"] else BEAR

    return {
        "bull": bull,
        "bear": bear,
        "bullish_pct": bull["pct"],
        "bearish_pct": bear["pct"],
        "bias": bias,
        "setup": BULL if bull["aligned"] else BEAR if bear["aligned"] else None,
        "note": (
            "Percentages are the share of the checklist that passes on this bar. "
            "They are counts of current conditions, not probabilities, and they say "
            "nothing about what price does next."
        ),
    }
