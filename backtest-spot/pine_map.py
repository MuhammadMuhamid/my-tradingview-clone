"""Map StrategyParams fields → Pine v5 input names for reporting."""

from __future__ import annotations

from strategy_sim import StrategyParams

PINE_FIELDS: list[tuple[str, str]] = [
    # S/R
    ("touch_atr",             "touchAtrMult"),
    ("piv_len_5",             "pivLen5"),
    ("piv_len_15",            "pivLen15"),
    ("piv_len_60",            "pivLen60"),
    ("piv_len_240",           "pivLen240"),
    ("retest_confirm_bars",   "retestConfirmBars"),
    ("prior_above_lb",        "priorAboveLb"),
    # MA trend
    ("use_ma_trend",          "useMaTrend"),
    ("ma1_len",               "ma1_len (TF1 1m)"),
    ("ma3_len",               "ma3_len (TF3 1h)"),
    # MA slope (new)
    ("require_ma_slope",      "requireMaSlope"),
    ("ma_slope_lb",           "maSlopeLb"),
    # VWMA
    ("use_vwma",              "useVwmaTrend"),
    ("vwma_len",              "vwmaLen (4h)"),
    # SuperTrend
    ("use_supertrend",        "useSuperTrend"),
    ("st_atr_len",            "stAtrLen"),
    ("st_mult",               "stMult"),
    # LinReg
    ("use_linreg",            "useLinReg"),
    ("lr_len",                "lrLen"),
    ("lr_tf",                 "lrTf"),
    # Local EMA stack (new)
    ("use_local_trend",       "useLocalTrend"),
    ("local_ema_fast",        "localEmaFast"),
    ("local_ema_slow",        "localEmaSlow"),
    # Volume filter (new)
    ("use_volume_filter",     "useVolumeFilter"),
    ("vol_ma_len",            "volMaLen"),
    ("vol_mult_min",          "volMultMin"),
    # HH structure (new)
    ("use_hh_structure",      "useHhStructure"),
    ("hh_pivot_len",          "hhPivotLen"),
    # Risk
    ("atr_len",               "atrLenExit"),
    ("sl_atr",                "slAtrMult"),
    ("struct_buff",           "structBuff"),
    ("tp_r",                  "tpR"),
    ("trail_trigger_r",       "trailTriggerR"),
    ("trail_atr",             "trailAtrMult"),
    ("trail_style",           "trailStyle  (ratchet=ATR from close / chandelier=Chandelier)"),
    ("min_sl_atr",            "minSlDistAtr"),
]


def params_to_pine_dict(p: StrategyParams) -> dict:
    return {pine_key: getattr(p, py_key) for py_key, pine_key in PINE_FIELDS}


def format_pine_report(p: StrategyParams, symbol: str = "", score: float = 0.0) -> str:
    lines = [
        f"# SR+Trend v5 — Best Pine inputs for {symbol}",
        f"# Composite score: {score:.4f}",
        "# Paste into TradingView Inputs panel",
        "",
    ]
    for py_key, pine_key in PINE_FIELDS:
        val = getattr(p, py_key)
        lines.append(f"{pine_key} = {val!r}")
    lines += [
        "",
        "# Fixed (not searched):",
        "# ma1_tf=1m, ma3_tf=1h, vwmaTf=4h, stTf=5m",
        "# exitMaTf=4h, exitMaLen=100, exitMaType=SMA (ON)",
        "# useExitBelowSt=OFF, useExitBelowMa1=OFF, useExitBelowLinReg=OFF",
        "# slMode = Below structure & ATR",
        "# tpMode = Risk multiple (R)",
        "# commission = 0.05%  initial_capital = 1000  qty = 930",
    ]
    return "\n".join(lines)
