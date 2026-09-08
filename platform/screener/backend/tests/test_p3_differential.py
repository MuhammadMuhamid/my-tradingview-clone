"""Integrity, determinism, causality and runtime bounds for P3's corpus."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

import pandas as pd

from app.indicators import classical

FIXTURE = Path(__file__).parent / "fixtures/p3_classical_differential_corpus.json"


def _hash(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def _frame(bars: list[dict]) -> pd.DataFrame:
    return pd.DataFrame({
        "ts": [row["open_time"] for row in bars],
        "open": [row["open"] for row in bars],
        "high": [row["high"] for row in bars],
        "low": [row["low"] for row in bars],
        "close": [row["close"] for row in bars],
    })


def test_corpus_has_required_spot_breadth_and_integrity():
    corpus = json.loads(FIXTURE.read_text())
    assert corpus["pair_count"] == 16
    assert corpus["window_count"] == 32
    assert corpus["bars_per_window"] == 600
    assert corpus["bar_count"] == 19_200
    assert set(corpus["timeframes"]) == {"1m", "5m", "15m", "1h", "4h", "1d"}
    assert corpus["catalog_count"] == 16
    for window in corpus["windows"]:
        assert window["venue"] == "BINANCE"
        assert window["market_type"] == "spot"
        assert len(window["bars"]) == 600
        assert _hash(window["bars"]) == window["ohlc_sha256"]
        assert window["settings_hash"] == classical.settings_hash(window["settings"])


def test_every_cached_scene_result_recomputes_byte_for_byte():
    corpus = json.loads(FIXTURE.read_text())
    for window in corpus["windows"]:
        result = classical.scan(_frame(window["bars"]), window["settings"])
        assert result["patterns"] == window["scene_patterns"], (
            window["symbol"], window["timeframe"], window["window_end_exclusive"]
        )


def test_corpus_occurrences_obey_point_in_time_contract():
    corpus = json.loads(FIXTURE.read_text())
    for window in corpus["windows"]:
        for pattern in window["scene_patterns"]:
            assert pattern["detected_at_index"] >= max(
                anchor["confirmed_at_index"] for anchor in pattern["anchors"]
            )
            if pattern["breakout"]:
                assert pattern["breakout"]["index"] >= pattern["detected_at_index"]
            if pattern["target"] and pattern["target"]["reached"]:
                assert pattern["target"]["reached"]["index"] > pattern["breakout"]["index"]
            if pattern["invalidation"]["triggered"]:
                assert pattern["invalidation"]["triggered"]["index"] > pattern["breakout"]["index"]


def test_prefixes_never_move_existing_anchors_or_detection_time():
    corpus = json.loads(FIXTURE.read_text())
    # Four structurally different windows, each checked at several horizons.
    for window in corpus["windows"][::8]:
        frame = _frame(window["bars"])
        seen: dict[str, tuple] = {}
        for end in range(100, len(frame) + 1, 25):
            result = classical.scan(frame.iloc[:end], window["settings"])
            for pattern in result["patterns"]:
                immutable = (
                    pattern["anchors"], pattern["detected_at_index"], pattern["detected_at"],
                    pattern["detected_open_time"], pattern["quality"],
                )
                assert seen.setdefault(pattern["occurrence_id"], immutable) == immutable


def test_full_corpus_runtime_is_bounded():
    corpus = json.loads(FIXTURE.read_text())
    started = time.perf_counter()
    for window in corpus["windows"]:
        classical.scan(_frame(window["bars"]), window["settings"])
    elapsed = time.perf_counter() - started
    assert elapsed < 5.0, f"32-window corpus took {elapsed:.3f}s"
