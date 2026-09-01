import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def isolated_config(tmp_path):
    """A ConfigStore whose overrides land in tmp, never in the repo.

    Tests must not write `config/user.json`: it makes them order-dependent and
    it stomps on whatever a locally-running server has configured.
    """
    from app import config as cfgmod

    return cfgmod.ConfigStore(
        default_path=cfgmod.DEFAULT_PATH,
        user_path=tmp_path / "user.json",
        symbols_path=cfgmod.SYMBOLS_PATH,
    )


@pytest.fixture(autouse=True)
def _guard_repo_config():
    """Fail loudly if any test leaves a user.json behind in the repo."""
    from app.config import USER_PATH

    existed = USER_PATH.exists()
    before = USER_PATH.read_bytes() if existed else None
    yield
    now = USER_PATH.exists()
    after = USER_PATH.read_bytes() if now else None
    assert (existed, before) == (now, after), (
        "a test mutated the repo's config/user.json — use the isolated_config fixture"
    )


@pytest.fixture
def store(tmp_path):
    from app.store import OhlcvStore

    s = OhlcvStore(tmp_path / "ohlcv.sqlite")
    yield s
    s.close()


@pytest.fixture(scope="session")
def btc_1h():
    """1799 closed BINANCE:BTCUSDT.P 1h bars, frozen 2026-08-28.

    The `.P` source identifies a TradingView perpetual fixture. It remains valid
    as deterministic numerical input for formula/parity/no-lookahead tests, but
    it is not evidence of Binance Spot exchange parity.

    Deep on purpose: Pine seeds `ta.ema` with an SMA, and a 200-period EMA still
    carries ~0.4% of that seed after 550 bars. 1799 puts it near 1e-7.
    """
    import pandas as pd

    path = Path(__file__).resolve().parent / "fixtures" / "BTCUSDT_1h.csv"
    df = pd.read_csv(path)
    df["ts"] = df["ts"].astype("int64")
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = df[col].astype("float64")
    return df
