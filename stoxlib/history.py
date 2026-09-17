"""EODHD data source: fetch and parse historical end-of-day prices.

Mirrors quotes.py and news.py's shape (same provider, same API key, same
error handling pattern) but owns its own concern -- historical OHLC bars,
not a live quote or a headline.
"""

from datetime import date, timedelta

import requests

from .quotes import EODHD_URL, api_key, normalize

PERIODS = {"d", "w", "m"}


class Bar:
    def __init__(self, code, date, open_, high, low, close, volume):
        self.code = code
        self.date = date
        self.open = open_
        self.high = high
        self.low = low
        self.close = close
        self.volume = volume

    def __eq__(self, other):
        return isinstance(other, Bar) and self.__dict__ == other.__dict__

    def __repr__(self):
        return "Bar(%r)" % (self.__dict__,)


class HistoryError(Exception):
    """Raised when historical prices can't be fetched at all (key/network/plan)."""


def _num(v):
    """EODHD uses the string 'NA' for missing fields -- coerce safely."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse(code, row: dict):
    close = _num(row.get("close"))
    if close is None or not row.get("date"):
        return None
    return Bar(
        code=code,
        date=row["date"],
        open_=_num(row.get("open")) or 0.0,
        high=_num(row.get("high")) or 0.0,
        low=_num(row.get("low")) or 0.0,
        close=close,
        volume=_num(row.get("volume")) or 0.0,
    )


def fetch_history(ticker, days=30, period="d"):
    """Return historical OHLC bars for one ticker, oldest first.

    `days` sets how far back to look from today; `period` is "d" (daily,
    the default), "w" (weekly), or "m" (monthly) -- an unrecognized value
    falls back to daily. Raises HistoryError on total failure (an unknown
    symbol just means an empty list).
    """
    key = api_key()
    if not key:
        raise HistoryError("no API key set -- see /help")

    if period not in PERIODS:
        period = "d"

    code = normalize(ticker)
    to_date = date.today()
    from_date = to_date - timedelta(days=days)
    params = {
        "api_token": key,
        "fmt": "json",
        "from": from_date.isoformat(),
        "to": to_date.isoformat(),
        "period": period,
    }

    try:
        r = requests.get("%s/eod/%s" % (EODHD_URL, code), params=params, timeout=10)
    except requests.RequestException as e:
        raise HistoryError("network error: %s" % e) from e

    if r.status_code in (401, 403):
        raise HistoryError("access denied -- check your key/plan")
    if r.status_code != 200:
        raise HistoryError("server returned HTTP %s" % r.status_code)
    try:
        data = r.json()
    except ValueError as e:
        raise HistoryError("couldn't parse server response") from e

    rows = data if isinstance(data, list) else [data]
    return [b for b in (_parse(code, row) for row in rows) if b]
