"""Precompute retest boolean masks per (frame, touch_atr, prior_lb)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from strategy_sim import retest_support


def precompute_retests(
    d: pd.DataFrame,
    touch_values: list[float],
    prior_values: list[int],
    reclaim_pierce_atr: float = 0.05,
) -> dict[tuple[float, int], np.ndarray]:
    out: dict[tuple[float, int], np.ndarray] = {}
    low, close = d["low"], d["close"]
    atrv = d["atr"]
    sups = [d["sup5"], d["sup15"], d["sup60"], d["sup240"]]
    for touch in touch_values:
        band = d["atr"] * touch
        for prior in prior_values:
            mask = pd.Series(False, index=d.index)
            for sup in sups:
                mask |= retest_support(low, close, sup, band, prior, atrv, reclaim_pierce_atr)
            out[(touch, prior)] = mask.to_numpy(dtype=bool)
    return out
