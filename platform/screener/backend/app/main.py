"""Entry point: `uvicorn app.main:app --reload`."""

from __future__ import annotations

import logging

from .api import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)

app = create_app()
