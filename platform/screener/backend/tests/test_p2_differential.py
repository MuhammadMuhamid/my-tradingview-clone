"""Integrity and practicality contract for the cached P2 comparison corpus."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

import pandas as pd

from app.indicators import candles

PATH = Path(__file__).parent / "fixtures" / "p2_differential_corpus.json"


def load():
    return json.loads(PATH.read_text())


def test_corpus_is_representative_frozen_binance_spot_and_exact_bar():
    payload = load()
    assert payload["pair_count"] == 16
    assert payload["window_count"] == 32
    assert payload["timeframes"] == ["15m", "1d", "1h", "1m", "4h", "5m"]
    assert len({w["symbol"] for w in payload["windows"]}) == 16
    for window in payload["windows"]:
        assert window["venue"] == "BINANCE" and window["market_type"] == "spot"
        assert len(window["bars"]) == 320
        raw = json.dumps(window["bars"], sort_keys=True, separators=(",", ":")).encode()
        assert hashlib.sha256(raw).hexdigest() == window["ohlc_sha256"]
        assert window["settings_hash"] == window["scene_occurrences"][0]["settings_hash"] \
            if window["scene_occurrences"] else True
        opens = {b["open_time"] for b in window["bars"]}
        assert all(hit["open_time"] in opens for hit in window["scene_occurrences"])


def test_cached_scene_occurrences_recompute_byte_for_byte():
    for window in load()["windows"]:
        frame = pd.DataFrame([{
            "ts": bar["open_time"], "open": bar["open"], "high": bar["high"],
            "low": bar["low"], "close": bar["close"],
        } for bar in window["bars"]])
        fresh = candles.scan(frame, window["settings"])["patterns"]
        fresh = [p for p in fresh if p["open_time"] >= window["score_start_open_time"]]
        assert fresh == window["scene_occurrences"]


def test_reviewed_window_has_exact_bar_differential_and_matching_ohlc_provenance():
    payload = load()
    reviewed = [w for w in payload["windows"]
                if w["tradingview"]["review_status"] == "reviewed_exact_bar"]
    assert len(reviewed) == 1
    window = reviewed[0]
    diff = window["differential"]
    assert diff["status"] == "reviewed_exact_bar"
    assert len(diff["exact_match"]) == 10
    assert len(diff["tv_only"]) == 1
    assert len(diff["bar_offset"]) == 1

    bar_by_open = {bar["open_time"]: bar for bar in window["bars"]}
    for observed in window["tradingview"]["ohlc_spot_checks"]:
        source = bar_by_open[observed["open_time"]]
        assert all(source[key] == observed[key]
                   for key in ("open", "high", "low", "close"))

    key = lambda value: (value["pattern_id"], value["open_time"])
    scene = {(hit["id"], hit["open_time"]) for hit in window["scene_occurrences"]}
    tv = {key(hit) for hit in window["tradingview"]["occurrences"]}
    exact = {key(hit) for hit in diff["exact_match"]}
    scene_only = {key(hit) for hit in diff["scene_only"]}
    tv_only = {key(hit) for hit in diff["tv_only"]}
    offset_scene = {(hit["pattern_id"], hit["scene_open_time"])
                    for hit in diff["bar_offset"]}
    offset_tv = {(hit["pattern_id"], hit["tradingview_open_time"])
                 for hit in diff["bar_offset"]}
    assert scene == exact | scene_only | offset_scene
    assert tv == exact | tv_only | offset_tv
    assert exact.isdisjoint(scene_only | tv_only | offset_scene | offset_tv)


def test_detector_performance_is_practical_for_loaded_chart_windows():
    frames = []
    for window in load()["windows"]:
        frames.append((pd.DataFrame([{
            "ts": b["open_time"], "open": b["open"], "high": b["high"],
            "low": b["low"], "close": b["close"],
        } for b in window["bars"]]), window["settings"]))
    started = time.perf_counter()
    for frame, settings in frames:
        candles.scan(frame, settings)
    elapsed = time.perf_counter() - started
    assert elapsed < 8.0, f"32 windows took {elapsed:.3f}s"
