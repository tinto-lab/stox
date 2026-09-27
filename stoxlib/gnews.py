"""Google News RSS data source: free, keyless world/geopolitical news search.

Unlike news.py (ticker-scoped, via EODHD's `s` param), geopolitical and
macro events aren't indexed by symbol -- tariffs, sanctions, elections,
and regional conflicts move a stock without ever mentioning its ticker.
This module takes a free-text query instead, so the geopolitics specialist
in analysis.py can search for the outside forces a company is exposed to.
No key and no bill, the way marketData.ts reaches Yahoo Finance from the
macOS app.

Two quirks this module absorbs so callers don't have to:

- Each item's <link> is a news.google.com redirect, not the publisher's
  URL, so full-text extraction (webfetch.py) can't read it as-is. We decode
  each one to the real URL through the same two-step lookup Google's own
  web page uses (see _decode_link), and keep the redirect link if that
  fails -- the article then just falls back to its summary.
- The feed carries no article text, country, or sentiment -- only title,
  date, and publisher -- so those GeoArticle fields stay empty and the
  summary names the publisher instead. (They're kept on GeoArticle so a
  richer source could fill them without touching the rendering.)
"""

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import requests

RSS_URL = "https://news.google.com/rss/search"
ARTICLE_URL = "https://news.google.com/rss/articles/"
BATCHEXECUTE_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute"

REQUEST_TIMEOUT = 15
_MAX_DECODE_WORKERS = 5

# Past week only. `when:` is Google News's own search operator; hl/gl/ceid pin the feed to US English.
_LOOKBACK = "when:7d"
_LOCALE_PARAMS = {"hl": "en-US", "gl": "US", "ceid": "US:en"}

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; stox/1.0; terminal research tool)"}

# Observed live: with a Mozilla-style User-Agent, the redirect page bounces
# to consent.google.com's cookie banner instead, so there's no signature to
# read. SOCS=CAI is the cookie Google sets when you pick "Reject all" on
# that banner -- sending it skips the banner.
_COOKIES = {"SOCS": "CAI"}

# Short-lived cache keyed on the exact (query, limit) pair, so a specialist
# trying overlapping search angles in one run -- or two runs for the same
# ticker minutes apart -- doesn't redo the several-request lookup (one feed
# fetch plus two per link decode). Process-local and in-memory is plenty
# for a cache this short-lived.
_CACHE_TTL_SECONDS = 300
_cache: dict = {}


def _cache_get(key):
    entry = _cache.get(key)
    if entry is None:
        return None
    cached_at, articles = entry
    if time.monotonic() - cached_at > _CACHE_TTL_SECONDS:
        del _cache[key]
        return None
    return articles


def _cache_set(key, articles):
    _cache[key] = (time.monotonic(), articles)


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


class GNewsError(Exception):
    """Raised when world news can't be fetched at all (network/HTTP/parse)."""


def _iso_date(pub_date):
    """RFC 822 pubDate ("Thu, 24 Sep 2026 06:38:16 GMT") -> ISO 8601, so
    callers can slice [:10] for the day."""
    try:
        return parsedate_to_datetime(pub_date).isoformat()
    except (TypeError, ValueError):
        return pub_date or ""


def _parse(item):
    title = (item.findtext("title") or "").strip()
    if not title:
        return None
    source = (item.findtext("source") or "").strip()
    # Google appends " - Publisher" to every title; the publisher is
    # already in the summary, so drop the duplicate.
    suffix = " - " + source
    if source and title.endswith(suffix):
        title = title[:-len(suffix)]
    return GeoArticle(
        title=title,
        date=_iso_date(item.findtext("pubDate")),
        link=(item.findtext("link") or "").strip(),
        country="",
        sentiment="",
        summary="(headline only, from %s)" % source if source else "",
    )


def is_redirect_link(link):
    """True for a news.google.com redirect we couldn't decode -- fetching
    it yields Google's consent/redirect page, not the article, so callers
    should skip full-text extraction and use the summary instead."""
    return (link or "").startswith(ARTICLE_URL)


def _decode_link(link):
    """Resolve a news.google.com/rss/articles/<id> redirect to the
    publisher's URL, or return None if that fails.

    The article id alone isn't enough anymore: the redirect page embeds a
    signature and timestamp (data-n-a-sg / data-n-a-ts) that Google's
    batchexecute endpoint needs alongside it before it hands back the
    real URL.
    """
    m = re.search(r"/articles/([^?/]+)", link or "")
    if not m:
        return None
    article_id = m.group(1)
    try:
        page = requests.get(ARTICLE_URL + article_id, headers=_HEADERS, cookies=_COOKIES,
                            timeout=REQUEST_TIMEOUT)
        sig = re.search(r'data-n-a-sg="([^"]+)"', page.text)
        ts = re.search(r'data-n-a-ts="([^"]+)"', page.text)
        if not (sig and ts):
            return None
        req = [
            "garturlreq",
            [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None,
              None, None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
            article_id, int(ts.group(1)), sig.group(1),
        ]
        r = requests.post(
            BATCHEXECUTE_URL,
            data={"f.req": json.dumps([[["Fbv4je", json.dumps(req), None, "generic"]]])},
            headers=_HEADERS, cookies=_COOKIES, timeout=REQUEST_TIMEOUT,
        )
        # The body is an anti-XSSI prefix line, a blank line, then JSON.
        payload = json.loads(r.text.split("\n\n", 1)[1])
        url = json.loads(payload[0][2])[1]
    except (requests.RequestException, ValueError, IndexError, KeyError, TypeError):
        return None
    return url if isinstance(url, str) and url.startswith(("http://", "https://")) else None


def fetch_geo_news(query, limit=5):
    """Return recent world-news articles matching a free-text query.

    `query` is arbitrary text (e.g. "Taiwan semiconductor export
    controls"), not a ticker -- geopolitical developments aren't indexed by
    symbol the way company news is.

    Raises GNewsError on total failure (no results just means an empty list).
    """
    cache_key = (query, limit)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Parenthesized so an OR in the model's query doesn't swallow the date
    # window ("a OR b when:7d" would only limit the b side).
    params = {"q": "(%s) %s" % (query, _LOOKBACK), **_LOCALE_PARAMS}
    try:
        r = requests.get(RSS_URL, params=params, headers=_HEADERS, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        raise GNewsError("network error: %s" % e) from e
    if r.status_code != 200:
        raise GNewsError("server returned HTTP %s" % r.status_code)
    try:
        root = ElementTree.fromstring(r.content)
    except ElementTree.ParseError as e:
        raise GNewsError("couldn't parse server response") from e

    articles = [a for a in (_parse(i) for i in root.iter("item")) if a][:max(1, limit)]
    if articles:
        with ThreadPoolExecutor(max_workers=min(len(articles), _MAX_DECODE_WORKERS)) as pool:
            real_links = list(pool.map(_decode_link, [a.link for a in articles]))
        for a, real in zip(articles, real_links):
            if real:
                a.link = real

    _cache_set(cache_key, articles)
    return articles
