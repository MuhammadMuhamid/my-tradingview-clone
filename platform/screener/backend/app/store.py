"""SQLite OHLCV store.

Keyed by `(exchange, symbol, timeframe, ts)` — never by indicator. Eight
indicators reading 1h off one symbol share one row set; that is the whole point
of §2.1 and it is enforced here by the primary key, not by convention.

Only closed bars are ever written. The forming bar is dropped upstream in
`cache.py` so that nothing downstream has to remember to.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pandas as pd

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "ohlcv.sqlite"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ohlcv (
    exchange  TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    timeframe TEXT    NOT NULL,
    ts        INTEGER NOT NULL,          -- bar OPEN time, ms since epoch, UTC
    open      REAL    NOT NULL,
    high      REAL    NOT NULL,
    low       REAL    NOT NULL,
    close     REAL    NOT NULL,
    volume    REAL    NOT NULL,
    PRIMARY KEY (exchange, symbol, timeframe, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS calibrations (
    exchange    TEXT    NOT NULL,
    symbol      TEXT    NOT NULL,
    timeframe   TEXT    NOT NULL,
    generated_at INTEGER NOT NULL,
    payload     TEXT    NOT NULL,       -- JSON blob, see app/calibration.py
    PRIMARY KEY (exchange, symbol, timeframe)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS series_meta (
    exchange     TEXT    NOT NULL,
    symbol       TEXT    NOT NULL,
    timeframe    TEXT    NOT NULL,
    fetched_at   INTEGER NOT NULL,       -- ms since epoch
    last_bar_ts  INTEGER NOT NULL,       -- open time of the newest closed bar held
    PRIMARY KEY (exchange, symbol, timeframe)
) WITHOUT ROWID;
"""

COLUMNS = ("ts", "open", "high", "low", "close", "volume")


class OhlcvStore:
    def __init__(self, path: Path | str = DEFAULT_DB) -> None:
        self.path = Path(path)
        if self.path.parent.name:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        with self._conn_for_setup() as conn:
            conn.executescript(_SCHEMA)

    def _conn_for_setup(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA journal_mode=WAL")
        return conn

    @property
    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return conn

    def upsert(self, exchange: str, symbol: str, timeframe: str, rows: list[list[float]]) -> int:
        """Insert closed bars. Re-fetched bars overwrite — an exchange revision wins."""
        if not rows:
            return 0
        payload = [(exchange, symbol, timeframe, int(r[0]), *(float(v) for v in r[1:6])) for r in rows]
        with self._conn as conn:
            conn.executemany(
                "INSERT INTO ohlcv (exchange,symbol,timeframe,ts,open,high,low,close,volume) "
                "VALUES (?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(exchange,symbol,timeframe,ts) DO UPDATE SET "
                "open=excluded.open, high=excluded.high, low=excluded.low, "
                "close=excluded.close, volume=excluded.volume",
                payload,
            )
        return len(payload)

    def load(self, exchange: str, symbol: str, timeframe: str, limit: int | None = None) -> pd.DataFrame:
        """Newest `limit` closed bars, returned oldest-first."""
        sql = (
            "SELECT ts,open,high,low,close,volume FROM ohlcv "
            "WHERE exchange=? AND symbol=? AND timeframe=? ORDER BY ts DESC"
        )
        args: list = [exchange, symbol, timeframe]
        if limit is not None:
            sql += " LIMIT ?"
            args.append(int(limit))
        rows = self._conn.execute(sql, args).fetchall()
        df = pd.DataFrame(rows[::-1], columns=list(COLUMNS))
        for col in COLUMNS:
            df[col] = df[col].astype("int64" if col == "ts" else "float64")
        return df

    def trim(self, exchange: str, symbol: str, timeframe: str, keep: int) -> int:
        """Drop all but the newest `keep` bars, so the cache does not grow forever."""
        with self._conn as conn:
            cur = conn.execute(
                "DELETE FROM ohlcv WHERE exchange=? AND symbol=? AND timeframe=? AND ts < "
                "(SELECT MIN(ts) FROM (SELECT ts FROM ohlcv WHERE exchange=? AND symbol=? "
                " AND timeframe=? ORDER BY ts DESC LIMIT ?))",
                (exchange, symbol, timeframe, exchange, symbol, timeframe, int(keep)),
            )
        return cur.rowcount

    def set_meta(self, exchange: str, symbol: str, timeframe: str, fetched_at: int, last_bar_ts: int) -> None:
        with self._conn as conn:
            conn.execute(
                "INSERT INTO series_meta (exchange,symbol,timeframe,fetched_at,last_bar_ts) "
                "VALUES (?,?,?,?,?) ON CONFLICT(exchange,symbol,timeframe) DO UPDATE SET "
                "fetched_at=excluded.fetched_at, last_bar_ts=excluded.last_bar_ts",
                (exchange, symbol, timeframe, int(fetched_at), int(last_bar_ts)),
            )

    def get_meta(self, exchange: str, symbol: str, timeframe: str) -> tuple[int, int] | None:
        row = self._conn.execute(
            "SELECT fetched_at,last_bar_ts FROM series_meta WHERE exchange=? AND symbol=? AND timeframe=?",
            (exchange, symbol, timeframe),
        ).fetchone()
        return (int(row[0]), int(row[1])) if row else None

    # --- calibrations --------------------------------------------------

    def save_calibration(self, exchange: str, symbol: str, timeframe: str, payload: dict) -> None:
        import json

        with self._conn as conn:
            conn.execute(
                "INSERT INTO calibrations (exchange,symbol,timeframe,generated_at,payload) "
                "VALUES (?,?,?,?,?) ON CONFLICT(exchange,symbol,timeframe) DO UPDATE SET "
                "generated_at=excluded.generated_at, payload=excluded.payload",
                (exchange, symbol, timeframe, int(payload.get("generated_at", 0)),
                 json.dumps(payload)),
            )

    def load_calibration(self, exchange: str, symbol: str, timeframe: str) -> dict | None:
        import json

        row = self._conn.execute(
            "SELECT payload FROM calibrations WHERE exchange=? AND symbol=? AND timeframe=?",
            (exchange, symbol, timeframe),
        ).fetchone()
        return json.loads(row[0]) if row else None

    def list_calibrations(self, exchange: str) -> list[dict]:
        import json

        rows = self._conn.execute(
            "SELECT payload FROM calibrations WHERE exchange=? ORDER BY symbol",
            (exchange,),
        ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None
