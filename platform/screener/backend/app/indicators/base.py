"""Shared contract for indicator modules.

Every module exposes exactly one entry point:

    def compute(df: pd.DataFrame, params: dict) -> dict

`df` is closed bars only, oldest first, with float columns
`open/high/low/close/volume` and an int64 `ts`. The return is flat and
JSON-serialisable: no NaN (use `None`), no numpy scalars, no nested frames.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd

MIN_BARS_MESSAGE = "insufficient bars"


class InsufficientData(ValueError):
    """Raised when a series is too short for the requested parameters."""

    def __init__(self, needed: int, got: int) -> None:
        super().__init__(f"{MIN_BARS_MESSAGE}: need {needed}, have {got}")
        self.needed = needed
        self.got = got


def require_bars(df: pd.DataFrame, needed: int) -> None:
    if len(df) < needed:
        raise InsufficientData(needed, len(df))


def jsonable(value: Any) -> Any:
    """Coerce a value to something `json.dumps` accepts. NaN and inf become None."""
    if value is None:
        return None
    if isinstance(value, (bool, str)):
        return value
    if isinstance(value, (int,)):
        return int(value)
    if isinstance(value, float) or hasattr(value, "item"):
        v = float(value)
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


def clean(out: dict) -> dict:
    return {k: jsonable(v) for k, v in out.items()}
