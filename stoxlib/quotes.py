"""EODHD data source: fetch and parse real-time quotes.

The only module that talks to the quote provider. Nothing in here knows
about the console, the agent, or how a Quote gets displayed.
"""

import os

import requests

from .numeric import _num

EODHD_URL = "https://eodhd.com/api"


def api_key() -> str:
    """Read EODHD_API_KEY on every call (not just at import time), so a key
    loaded from a .env file after this module is imported is still seen."""
    return os.environ.get("EODHD_API_KEY", "")


class Quote:
    def __init__(self, code, price, change, percent, open_, high, low,
                 prev_close, volume):
        self.code = code
        self.price = price
        self.change = change
        self.percent = percent
        self.open = open_
        self.high = high
        self.low = low
        self.prev_close = prev_close
        self.volume = volume

    def __eq__(self, other):
        return isinstance(other, Quote) and self.__dict__ == other.__dict__

    def __repr__(self):
        return "Quote(%r)" % (self.__dict__,)


class QuoteError(Exception):
    """Raised when quotes can't be fetched at all (key/network/plan)."""


def normalize(ticker: str) -> str:
    t = ticker.upper()
    return t if "." in t else t + ".US"


def _parse(row: dict):
    close = _num(row.get("close"))
    if close is None:
        return None  # unknown symbol / no data
    return Quote(
        code=row.get("code", "?"),
        price=close,
        change=_num(row.get("change")) or 0.0,
        percent=_num(row.get("change_p")) or 0.0,
        open_=_num(row.get("open")) or 0.0,
        high=_num(row.get("high")) or 0.0,
        low=_num(row.get("low")) or 0.0,
        prev_close=_num(row.get("previousClose")) or 0.0,
        volume=_num(row.get("volume")) or 0.0,
    )


def fetch_quotes(tickers):
    """Return (quotes, missing_codes). Raises QuoteError on total failure."""
    key = api_key()
    if not key:
        raise QuoteError("no API key set -- see /help")

    codes = [normalize(t) for t in tickers]
    params = {"api_token": key, "fmt": "json"}
    if codes[1:]:
        params["s"] = ",".join(codes[1:])

    try:
        r = requests.get("%s/real-time/%s" % (EODHD_URL, codes[0]),
                         params=params, timeout=10)
    except requests.RequestException as e:
        raise QuoteError("network error: %s" % e) from e

    if r.status_code in (401, 403):
        raise QuoteError("access denied -- check your key/plan "
                         "(free real-time is limited to the demo tickers)")
    if r.status_code != 200:
        raise QuoteError("server returned HTTP %s" % r.status_code)
    try:
        data = r.json()
    except ValueError as e:
        raise QuoteError("couldn't parse server response") from e

    rows = data if isinstance(data, list) else [data]
    quotes = [q for q in (_parse(row) for row in rows) if q]
    found = {q.code for q in quotes}
    missing = [c for c in codes if c not in found]
    return quotes, missing
