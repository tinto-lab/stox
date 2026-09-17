"""webz.io data source: general/world news search.

Unlike news.py (ticker-scoped, via EODHD's `s` param), geopolitical and
macro events aren't indexed by symbol -- tariffs, sanctions, elections,
and regional conflicts move a stock without ever mentioning its ticker.
This module takes a free-text query instead, so the geopolitics specialist
in analysis.py can search for the outside forces a company is exposed to.

Mirrors news.py's shape (own concern, own error type, same parse-defensively
style) but is otherwise independent of it -- a change to one provider has
no reason to touch the other.
"""

import os
import time

import requests

WEBZ_URL = "https://api.webz.io/api/news"

# Observed live: this plan's rate limit is tight enough that two calls a
# fraction of a second apart already 429s the second one, but it clears up
# within a second or two -- so a short bounded retry absorbs that instead of
# surfacing "rate limited" for what's really just back-to-back calls (e.g.
# the geopolitics specialist trying a second search angle right after the
# first).
_RATE_LIMIT_RETRIES = 2
_RATE_LIMIT_BACKOFF = 1.5


def api_key() -> str:
    """Read WEBZ_API_KEY on every call (not just at import time), so a key
    loaded from a .env file after this module is imported is still seen."""
    return os.environ.get("WEBZ_API_KEY", "")


class GeoArticle:
    def __init__(self, title, date, link, country, sentiment, summary):
        self.title = title
        self.date = date
        self.link = link
        self.country = country
        self.sentiment = sentiment
        self.summary = summary

    def __eq__(self, other):
        return isinstance(other, GeoArticle) and self.__dict__ == other.__dict__

    def __repr__(self):
        return "GeoArticle(%r)" % (self.__dict__,)


class WebzError(Exception):
    """Raised when world news can't be fetched at all (key/network/plan)."""


def _truncate(text, limit=240):
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0] + "…"


def _parse(row: dict):
    title = row.get("title")
    if not title:
        return None
    thread = row.get("thread") or {}
    return GeoArticle(
        title=title,
        date=row.get("published", ""),
        link=row.get("url", ""),
        country=thread.get("country", ""),
        sentiment=row.get("sentiment", ""),
        summary=_truncate(row.get("text", "")),
    )


def _retry_delay(response, attempt):
    """Seconds to wait before retrying a 429: honor Retry-After if the
    server sends one, else back off exponentially from _RATE_LIMIT_BACKOFF."""
    retry_after = response.headers.get("Retry-After")
    if retry_after is not None:
        try:
            return float(retry_after)
        except ValueError:
            pass
    return _RATE_LIMIT_BACKOFF * (2 ** attempt)


def fetch_geo_news(query, limit=5):
    """Return recent world-news articles matching a free-text query.

    `query` is arbitrary text (e.g. "Taiwan semiconductor export
    controls"), not a ticker -- geopolitical developments aren't indexed by
    symbol the way company news is.

    Raises WebzError on total failure (no results just means an empty list).
    """
    key = api_key()
    if not key:
        raise WebzError("no API key set -- see /help")

    # the News API has no size/limit param -- it returns a fixed page (see
    # docs.webz.io/docs/webz/news-api-filters), so `limit` is enforced by
    # trimming the parsed results below instead of by the request itself
    params = {"token": key, "q": query}

    r = None
    for attempt in range(_RATE_LIMIT_RETRIES + 1):
        try:
            r = requests.get(WEBZ_URL, params=params, timeout=15)
        except requests.RequestException as e:
            raise WebzError("network error: %s" % e) from e

        if r.status_code != 429 or attempt == _RATE_LIMIT_RETRIES:
            break
        time.sleep(_retry_delay(r, attempt))

    if r.status_code == 429:
        raise WebzError("rate limited -- try again in a moment")
    if r.status_code in (401, 403):
        raise WebzError("access denied -- check your key/plan")
    if r.status_code != 200:
        raise WebzError("server returned HTTP %s" % r.status_code)
    try:
        data = r.json()
    except ValueError as e:
        raise WebzError("couldn't parse server response") from e

    rows = data.get("posts", []) if isinstance(data, dict) else []
    return [a for a in (_parse(row) for row in rows) if a][:limit]
