"""API layer — endpoints, and the §2.4 rule that reads never fetch."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.config import ConfigStore
from app.service import ScreenerService
from app.calibration import INSUFFICIENT
from app.store import OhlcvStore
from tests.fakes import FakeFeed


@pytest.fixture
def client(tmp_path, monkeypatch, isolated_config):
    from app import config as cfgmod
    from app import service as svcmod

    monkeypatch.setattr(svcmod, "PRESETS_PATH", tmp_path / "presets.json")

    cfg = isolated_config
    # 700 bars rather than the production 1800: deep enough for every indicator
    # (VFI needs 267, EMA 200 needs 201) and it keeps the suite quick. The
    # EMA-seed argument for 1800 is about accuracy against TradingView, which
    # these tests do not assert.
    cfg.update({"data": {"fetch_bars": 700}})
    feed = FakeFeed(cfg.doc["symbols"] + ["NEW/USDT"])
    store = OhlcvStore(tmp_path / "ohlcv.sqlite")
    svc = ScreenerService(config=cfg, feed=feed, store=store)

    app = create_app(service=svc, schedule=False)
    with TestClient(app) as c:
        c.svc = svc          # type: ignore[attr-defined]
        c.feed = feed        # type: ignore[attr-defined]
        yield c


# --- read --------------------------------------------------------------


def test_health_reports_resolution_state(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["symbols"] == 36
    assert body["resolved"] == 36
    assert body["unresolved"] == 0
    # Eight columns on 1h plus the strategy's three slots.
    assert body["timeframes"] == ["5m", "15m", "1h"]
    assert body["last_refresh_at"] is not None


def test_screener_returns_one_row_per_symbol_with_all_canonical_indicators(client):
    body = client.get("/api/screener").json()
    assert len(body["rows"]) == 36

    row = next(r for r in body["rows"] if r["symbol"] == "BTC/USDT")
    assert row["state"] == "ok"
    assert set(row["indicators"]) == {
        "ema", "rsi", "macd", "adx", "vfi", "supertrend", "sr", "candles", "classical"
    }
    assert row["errors"] == {}
    assert row["price"] is not None


def test_every_row_carries_the_source_bar_timestamp(client):
    """§2.2 — the UI needs the close time of the bar each value came from."""
    body = client.get("/api/screener").json()
    for row in body["rows"]:
        series = row["series"]["1h"]
        assert series["last_bar_ts"] is not None
        assert series["last_close_ts"] == series["last_bar_ts"] + 3_600_000
        assert series["stale"] is False
        assert series["bars"] > 600


def test_reading_the_screener_never_triggers_a_fetch(client):
    """§2.4 — refresh is a scheduled pull; the UI reads the cache."""
    before = client.feed.total_fetches
    for _ in range(3):
        client.get("/api/screener")
        client.get("/api/symbols")
        client.get("/api/config")
    assert client.feed.total_fetches == before


def test_snapshot_is_json_serialisable_and_reports_its_own_cost(client):
    body = client.get("/api/screener").json()
    json.dumps(body)
    assert body["compute_ms"] > 0
    assert body["exchange"] == "fakeex"


def test_snapshot_market_identity_is_explicitly_spot(client):
    body = client.get("/api/screener").json()
    assert body["market"] == {
        "exchange": "fakeex",
        "market_type": "spot",
        "contract_type": None,
        "linear": False,
        "spot": True,
    }
    btc = next(row for row in body["rows"] if row["symbol"] == "BTC/USDT")
    assert btc["market"]["config_symbol"] == "BTC/USDT"
    assert btc["market"]["native_symbol"] == "BTC/USDT"
    assert btc["market"]["spot"] is True


def _pattern_request(client, **overrides):
    rows = client.feed.series("BTC/USDT", "1h", 90)
    candles = [
        {
            "open_time": int(row[0]), "open": row[1], "high": row[2],
            "low": row[3], "close": row[4], "close_time": int(row[0]) + 3_600_000 - 1,
        }
        for row in rows
    ]
    body = {
        "venue": "BINANCE", "market_type": "spot", "symbol": "BTCUSDT",
        "timeframe": "1h", "as_of": candles[-2]["close_time"], "candles": candles,
    }
    body.update(overrides)
    return body


def test_pattern_catalog_is_versioned_causal_and_complete(client):
    body = client.get("/api/patterns/catalog").json()
    assert body["detector_id"] == "trading-scene-candlesticks"
    assert body["detector_version"] == "2.0.0"
    assert body["confirmation"] == "bar_close"
    assert body["causal"] is True
    assert body["predictive_claim"] is False
    assert len(body["patterns"]) == 44
    assert len({item["id"] for item in body["patterns"]}) == 44


def test_classical_catalog_is_versioned_causal_and_matches_current_official_surface(client):
    body = client.get("/api/classical-patterns/catalog").json()
    assert body["detector_id"] == "trading-scene-classical-patterns"
    assert body["detector_version"] == "1.0.0"
    assert body["search_horizon_bars"] == 600
    assert body["pivot_confirmation"] == {"left_bars": 5, "right_bars": 5}
    assert body["causal"] is True
    assert body["predictive_claim"] is False
    assert len(body["patterns"]) == 16
    assert len({item["id"] for item in body["patterns"]}) == 16


def test_pattern_analysis_excludes_forming_bar_and_preserves_provenance(client):
    request = _pattern_request(client)
    body = client.post("/api/patterns/analyze", json=request).json()
    assert body["source"] == {
        "venue": "BINANCE", "market_type": "spot", "symbol": "BTCUSDT",
        "timeframe": "1h", "ohlc": "caller_supplied_binance_spot",
        "as_of": request["as_of"], "closed_bars_analyzed": 89,
        "forming_bars_excluded": 1,
    }
    assert body["settings"]["bar_duration_ms"] == 3_600_000
    assert body["input_end_open_time"] == request["candles"][-2]["open_time"]
    for hit in body["patterns"]:
        assert hit["confirmed_at"] == hit["open_time"] + 3_600_000
        assert hit["detector_version"] == body["detector_version"]


def test_classical_analysis_excludes_forming_bar_and_preserves_causal_provenance(client):
    request = _pattern_request(client)
    body = client.post("/api/classical-patterns/analyze", json=request).json()
    assert body["source"]["closed_bars_analyzed"] == 89
    assert body["source"]["forming_bars_excluded"] == 1
    assert body["source"]["venue"] == "BINANCE"
    assert body["source"]["market_type"] == "spot"
    assert body["settings"]["bar_duration_ms"] == 3_600_000
    assert body["search_horizon_bars"] == 600
    for hit in body["patterns"]:
        assert hit["detected_at_index"] >= hit["anchors"][-1]["confirmed_at_index"]
        assert hit["detector_version"] == body["detector_version"]
        assert hit["predictive_claim"] is False
        assert hit["settings_hash"] == body["settings_hash"]


@pytest.mark.parametrize("patch", [
    {"venue": "COINBASE"},
    {"market_type": "future"},
    {"symbol": "BTC/USDT"},
    {"timeframe": "calendar"},
])
def test_pattern_analysis_rejects_noncanonical_market_identity(client, patch):
    assert client.post("/api/patterns/analyze", json=_pattern_request(client, **patch)).status_code == 422


def test_pattern_analysis_rejects_bad_ohlc_duplicate_time_and_bad_close_time(client):
    for mutate in ("geometry", "duplicate", "close_time"):
        request = _pattern_request(client)
        if mutate == "geometry":
            request["candles"][10]["high"] = request["candles"][10]["low"] - 1
        elif mutate == "duplicate":
            request["candles"][10]["open_time"] = request["candles"][9]["open_time"]
        else:
            request["candles"][10]["close_time"] += 1
        response = client.post("/api/patterns/analyze", json=request)
        assert response.status_code == 422, mutate


def test_pattern_analysis_rejects_settings_that_are_not_canonical(client):
    response = client.post("/api/patterns/analyze", json=_pattern_request(
        client, settings={"future_confirmation": True},
    ))
    assert response.status_code == 422
    assert "unsupported candlestick setting" in response.json()["detail"]


def test_screener_supplies_exact_pattern_confirmation_duration(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert row["indicators"]["candles"]["settings"]["bar_duration_ms"] == 3_600_000


# --- refresh -----------------------------------------------------------


def test_refresh_inside_the_ttl_fetches_nothing(client):
    before = client.feed.total_fetches
    report = client.post("/api/refresh").json()
    assert report["fetched"] == 0
    assert report["served_from_cache"] == 36 * 3
    assert client.feed.total_fetches == before


def test_forced_refresh_refetches_each_pair_exactly_once(client):
    before = client.feed.total_fetches
    report = client.post("/api/refresh?force=true").json()
    assert report["fetched"] == 36 * 3
    assert client.feed.total_fetches == before + 36 * 3


# --- config ------------------------------------------------------------


def test_patch_config_changes_one_indicator_timeframe_and_backfills(client):
    before = client.feed.total_fetches
    body = client.patch("/api/config", json={"indicators": {"rsi": {"timeframe": "4h"}}}).json()

    assert body["config"]["indicators"]["rsi"]["timeframe"] == "4h"
    assert body["config"]["indicators"]["ema"]["timeframe"] == "1h"
    # Only the newly-required (symbol, 4h) pairs are fetched; 5m, 15m and 1h are
    # already held and still inside their TTL.
    assert body["refresh"]["fetched"] == 36
    assert body["refresh"]["served_from_cache"] == 36 * 3
    assert client.feed.total_fetches == before + 36

    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert set(row["series"]) == {"5m", "15m", "1h", "4h"}


def test_patch_config_rejects_an_unsupported_timeframe(client):
    r = client.patch("/api/config", json={"indicators": {"rsi": {"timeframe": "7m"}}})
    assert r.status_code == 422
    assert "not supported" in r.json()["detail"]
    assert client.get("/api/config").json()["config"]["indicators"]["rsi"]["timeframe"] == "1h"


def test_patch_config_rejects_out_of_scope_indicators(client):
    r = client.patch("/api/config", json={
        "indicators": {"bollinger": {"enabled": True, "timeframe": "1h", "params": {}}}
    })
    assert r.status_code == 422
    assert "unknown indicator" in r.json()["detail"]


def test_disabling_an_indicator_drops_it_from_every_row(client):
    client.patch("/api/config", json={"indicators": {"vfi": {"enabled": False}}})
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert "vfi" not in row["indicators"]
    assert len(row["indicators"]) == 8


# --- symbols -----------------------------------------------------------


def test_add_symbol_validates_before_persisting(client):
    r = client.post("/api/symbols", json={"symbol": "NEW/USDT"})
    assert r.status_code == 200
    assert client.get("/api/health").json()["symbols"] == 37

    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "NEW/USDT")
    assert row["state"] == "ok", "a newly added symbol must be backfilled, not left empty"
    assert row["indicators"]


def test_add_symbol_rejects_one_the_exchange_does_not_list(client):
    r = client.post("/api/symbols", json={"symbol": "NOPE/USDT"})
    assert r.status_code == 422
    assert "not listed" in r.json()["detail"]
    assert client.get("/api/health").json()["symbols"] == 36


def test_add_symbol_rejects_a_malformed_one(client):
    assert client.post("/api/symbols", json={"symbol": "BTCUSDT"}).status_code == 422
    assert client.post("/api/symbols", json={"symbol": "BTC/USDT"}).status_code == 422


def test_remove_symbol(client):
    assert client.delete("/api/symbols/ALGO/USDT").status_code == 200
    assert "ALGO/USDT" not in client.get("/api/symbols").json()["symbols"]
    assert client.delete("/api/symbols/ALGO/USDT").status_code == 404


def test_unresolved_symbols_render_as_a_distinct_state_not_a_crash(client, tmp_path):
    """§2.5 — never silently dropped, never fatal."""
    client.svc.resolution.unresolved["GHOST/USDT"] = "not listed on this exchange"
    client.svc.config.update({"symbols": client.svc.config.doc["symbols"] + ["GHOST/USDT"]})

    rows = client.get("/api/screener").json()["rows"]
    ghost = next(r for r in rows if r["symbol"] == "GHOST/USDT")
    assert ghost["state"] == "unresolved"
    assert ghost["note"] == "not listed on this exchange"
    assert ghost["indicators"] == {}
    assert len(rows) == 37, "the row must still be present"


# --- presets -----------------------------------------------------------


def test_preset_round_trip(client):
    client.patch("/api/config", json={"indicators": {"ema": {"timeframe": "4h"},
                                                     "rsi": {"timeframe": "4h"}}})
    assert client.post("/api/presets", json={"name": "swing"}).status_code == 200

    client.patch("/api/config", json={"indicators": {"ema": {"timeframe": "1h"},
                                                     "rsi": {"timeframe": "1h"}}})
    assert client.get("/api/config").json()["config"]["indicators"]["ema"]["timeframe"] == "1h"

    body = client.post("/api/presets/swing/load").json()
    assert body["loaded"] is True
    assert client.get("/api/config").json()["config"]["indicators"]["ema"]["timeframe"] == "4h"

    assert "swing" in client.get("/api/presets").json()["presets"]
    assert client.delete("/api/presets/swing").status_code == 200
    assert client.get("/api/presets").json()["presets"] == {}


def test_loading_a_missing_preset_is_a_404(client):
    assert client.post("/api/presets/nope/load").status_code == 404
    assert client.post("/api/presets", json={"name": "  "}).status_code == 422


# --- resilience --------------------------------------------------------


def test_one_failing_indicator_does_not_blank_the_row(client, monkeypatch):
    from app.indicators import rsi as rsi_mod

    def boom(df, params):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(rsi_mod, "compute", boom)
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")

    assert row["state"] == "partial"
    assert "synthetic failure" in row["errors"]["rsi"]
    assert len(row["indicators"]) == 8, "the other eight must still be there"


# --- scoring (§6.1) ----------------------------------------------------


def test_every_row_carries_a_score_with_a_visible_breakdown(client):
    body = client.get("/api/screener").json()
    row = next(r for r in body["rows"] if r["symbol"] == "BTC/USDT")

    score = row["score"]
    assert score["label"] == "Confluence Score"
    assert "not a probability" in score["disclaimer"]
    assert 0.0 <= score["score"] <= 100.0
    assert set(score["buckets"]) == {"trend", "momentum", "volume", "location", "trigger"}
    assert all(b["components"] for b in score["buckets"].values() if b["available"])


def test_the_snapshot_advertises_the_label_and_disclaimer(client):
    scoring = client.get("/api/screener").json()["scoring"]
    assert scoring["label"] == "Confluence Score"
    assert scoring["mode"] == "confluence_score"
    assert "not been validated against forward returns" in scoring["disclaimer"]
    assert scoring["ranging_multiplier"] == 0.5


def test_scoring_weights_are_configurable_through_the_api(client):
    before = next(
        r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT"
    )["score"]

    r = client.patch("/api/config", json={"scoring": {"weights": {"trend": 0}}})
    assert r.status_code == 200

    after = next(
        r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT"
    )["score"]
    assert after["buckets"]["trend"]["effective_weight"] == 0.0
    assert after["score"] != before["score"]


def test_unknown_scoring_buckets_are_rejected(client):
    r = client.patch("/api/config", json={"scoring": {"weights": {"vibes": 50}}})
    assert r.status_code == 422
    assert "unknown scoring bucket" in r.json()["detail"]


def test_empirical_probability_mode_is_off_by_default(client):
    """§6.2 — only that mode may use the word probability, and it is not on."""
    cfg = client.get("/api/config").json()["config"]
    assert cfg["scoring"]["mode"] == "confluence_score"
    assert cfg["scoring"]["empirical"]["enabled"] is False


# --- calibration (§6.2) ------------------------------------------------


def test_calibration_endpoints_round_trip(client):
    r = client.post("/api/calibrate/BTC/USDT?with_sr=false")
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "BTC/USDT"
    assert "warnings" in body

    stored = client.get("/api/calibration/BTC/USDT").json()
    assert stored["symbol"] == "BTC/USDT"
    assert stored["generated_at"] > 0

    listing = client.get("/api/calibrations").json()["calibrations"]
    assert any(c["symbol"] == "BTC/USDT" for c in listing)


def test_calibration_for_an_uncalibrated_symbol_is_a_404(client):
    assert client.get("/api/calibration/ETH/USDT").status_code == 404


def test_calibrating_an_unresolved_symbol_is_rejected(client):
    assert client.post("/api/calibrate/GHOST/USDT").status_code == 422


def test_rows_carry_no_empirical_field_while_the_mode_is_off(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert row["empirical"] is None, "§6.2 is off by default and must stay silent"


def test_enabling_the_empirical_mode_attaches_a_rate_with_its_sample_size(client):
    client.post("/api/calibrate/BTC/USDT?with_sr=false")
    client.patch("/api/config", json={"scoring": {"empirical": {"enabled": True}}})

    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    emp = row["empirical"]
    assert emp is not None
    # Either a rate with its n, or a refusal that still reports n. Never a bare
    # percentage, and never a refusal that hides how thin the sample was.
    assert "n=" in emp["display"]
    if emp["hit_rate"] is not None:
        assert emp["n"] >= 100, "a rate must never be shown on fewer samples than the minimum"
        assert "%" in emp["display"]
    else:
        assert INSUFFICIENT in emp["display"]


def test_an_uncalibrated_symbol_says_so_rather_than_borrowing_another(client):
    """A rate calibrated on BTC does not transfer to ETH."""
    client.post("/api/calibrate/BTC/USDT?with_sr=false")
    client.patch("/api/config", json={"scoring": {"empirical": {"enabled": True}}})

    eth = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "ETH/USDT")
    assert eth["empirical"]["display"] == "not calibrated"
    assert eth["empirical"]["hit_rate"] is None


# --- MTF strategy ------------------------------------------------------


def test_every_row_carries_the_mtf_checklist(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    st = row["strategy"]

    assert set(st["timeframes_used"]) == {"1h", "15m", "5m"}
    assert set(st["bull"]["timeframes"]) == {"1h", "15m", "5m"}
    assert st["bullish_pct"] is not None and 0 <= st["bullish_pct"] <= 100
    assert st["bearish_pct"] is not None and 0 <= st["bearish_pct"] <= 100
    assert st["bias"] in ("bull", "bear", "none")


def test_the_strategy_endpoint_returns_the_checklist_without_the_columns(client):
    body = client.get("/api/strategy").json()
    assert body["strategy"]["enabled"] is True
    assert set(body["strategy"]["rules"]) == {"1h", "15m", "5m"}
    assert all(len(v) == 7 for v in body["strategy"]["rules"].values())

    row = next(r for r in body["rows"] if r["symbol"] == "BTC/USDT")
    assert "indicators" not in row
    assert row["strategy"]["bull"]["total"] == 20


def test_the_strategy_pulls_its_own_timeframes_into_the_fetch_set(client):
    """1h, 15m and 5m all need candles, and they share the column cache."""
    assert set(client.get("/api/health").json()["timeframes"]) >= {"5m", "15m", "1h"}
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert set(row["series"]) >= {"5m", "15m", "1h"}


def test_each_strategy_timeframe_reports_its_own_source_bar(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    series = row["strategy"]["series"]
    assert series["1h"]["timeframe"] == "1h"
    assert series["15m"]["timeframe"] == "15m"
    assert series["5m"]["timeframe"] == "5m"
    assert series["5m"]["last_close_ts"] > 0


def test_the_strategy_disclaimer_is_served_with_the_snapshot(client):
    note = client.get("/api/screener").json()["strategy"]["note"]
    assert "not probabilities" in note


def test_rejecting_an_unsupported_strategy_timeframe(client):
    r = client.patch("/api/config", json={"strategy": {"timeframes": {"1h": "9m", "15m": "15m", "5m": "5m"}}})
    assert r.status_code == 422
    assert "not supported" in r.json()["detail"]


def test_reads_still_never_fetch_with_the_strategy_on(client):
    before = client.feed.total_fetches
    for _ in range(3):
        client.get("/api/screener")
        client.get("/api/strategy")
    assert client.feed.total_fetches == before


# --- per-timeframe columns ---------------------------------------------


def test_rows_expose_every_indicator_at_each_strategy_timeframe(client):
    """The columns are per-timeframe now, so the payload has to be too."""
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    mtf = row["mtf"]

    assert set(mtf) == {"1h", "15m", "5m"}
    for slot in ("1h", "15m", "5m"):
        assert {"ema", "rsi", "macd", "adx", "supertrend", "sr", "vfi", "pivots", "vwap"} <= set(mtf[slot])

    assert mtf["1h"]["ema"]["dist_pct_21"] is not None
    assert mtf["15m"]["ema"]["dist_pct_200"] is not None
    assert mtf["5m"]["vwap"]["bias"] in ("bull", "bear")
    assert mtf["5m"]["pivots"]["nearest_dist_pct"] is not None
    assert mtf["1h"]["sr"]["dist_to_support_pct"] is not None


def test_the_mtf_payload_drops_the_bulky_level_lists(client):
    """36 symbols x 3 timeframes x a full level list is response bloat."""
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    for slot in ("1h", "15m", "5m"):
        assert "levels" not in row["mtf"][slot]["sr"]
        assert "nearest_support" in row["mtf"][slot]["sr"]
    # The primary-timeframe block still carries them for the row-expand panel.
    assert "levels" in row["indicators"]["sr"]


def test_pivot_distances_are_available_as_percent(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    pivots = row["mtf"]["5m"]["pivots"]
    assert pivots["type"] == "Fibonacci"
    assert pivots["anchor"] == "Daily", "5m anchors daily per the built-in's Auto rule"
    assert pivots["nearest_abs_pct"] == pytest.approx(abs(pivots["nearest_dist_pct"]))
    assert set(pivots["levels"]) == {"P", "R1", "R2", "R3", "S1", "S2", "S3"}


def test_the_1h_pivots_anchor_weekly(client):
    row = next(r for r in client.get("/api/screener").json()["rows"] if r["symbol"] == "BTC/USDT")
    assert row["mtf"]["1h"]["pivots"]["anchor"] == "Weekly"
