"""EODHD data source: fetch and parse recent financial news.

Mirrors quotes.py's shape (same provider, same API key, same error
handling pattern) but owns its own concern -- news, not prices -- so a
change to one has no reason to touch the other.
"""

import requests

from .quotes import EODHD_URL, api_key, normalize


class Article:
    def __init__(self, title, date, link, symbols, sentiment, summary):
        self.title = title
        self.date = date
        self.link = link
        self.symbols = symbols
        self.sentiment = sentiment
        self.summary = summary

    def __eq__(self, other):
        return isinstance(other, Article) and self.__dict__ == other.__dict__

    def __repr__(self):
        return "Article(%r)" % (self.__dict__,)


class NewsError(Exception):
    """Raised when news can't be fetched at all (key/network/plan)."""


def _truncate(text, limit=240):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


def _parse(row: dict):
    title = row.get("title")
    if not title:
        return None
    return Article(
        title=title,
        date=row.get("date", ""),
        link=row.get("link", ""),
        symbols=row.get("symbols") or [],
        sentiment=row.get("sentiment") or {},
        summary=_truncate(row.get("content", "")),
    )


def fetch_news(tickers, limit=5):
    """Return recent articles mentioning any of the given tickers.

    Raises NewsError on total failure (no results just means an empty list).
    """
    key = api_key()
    if not key:
        raise NewsError("no API key set -- see /help")

    codes = [normalize(t) for t in tickers]
    params = {
        "api_token": key,
        "fmt": "json",
        "s": ",".join(codes),
        "limit": limit,
    }

    try:
        # EODHD's ticker-filtered news query (the `s` param) is inherently
        # slow -- 10-17s observed even for a single ticker, vs. under 2s for
        # quotes/history -- so it needs a longer timeout than the other
        # endpoints, not just a bigger margin for jitter.
        r = requests.get("%s/news" % EODHD_URL, params=params, timeout=25)
    except requests.RequestException as e:
        raise NewsError("network error: %s" % e) from e

    if r.status_code in (401, 403):
        raise NewsError("access denied -- check your key/plan")
    if r.status_code != 200:
        raise NewsError("server returned HTTP %s" % r.status_code)
    try:
        data = r.json()
    except ValueError as e:
        raise NewsError("couldn't parse server response") from e

    rows = data if isinstance(data, list) else [data]
    return [a for a in (_parse(row) for row in rows) if a]
