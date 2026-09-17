"""Generic web page fetching: turn a URL into readable article text.

Unlike quotes.py/news.py, this doesn't talk to EODHD at all -- it fetches
whatever http(s) URL it's given and extracts the main readable text from
the page, stripping nav/ads/boilerplate. Used by the agent to read past
a news article's short EODHD summary when that isn't enough to answer
the question.
"""

import trafilatura
import requests

REQUEST_TIMEOUT = 10
MAX_CHARS = 4000

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; stox/1.0; terminal research tool)"
}


class FetchError(Exception):
    """Raised when a page can't be fetched or no readable text could be found."""


def fetch_article_text(url: str, max_chars: int = MAX_CHARS) -> str:
    """Download `url` and return its main readable text, truncated to
    max_chars at a word boundary.
    """
    if not url or not url.startswith(("http://", "https://")):
        raise FetchError("not a valid http(s) URL")

    try:
        r = requests.get(url, headers=_HEADERS, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as e:
        raise FetchError("network error: %s" % e) from e

    if r.status_code != 200:
        raise FetchError("server returned HTTP %s" % r.status_code)

    text = trafilatura.extract(r.text, url=url)
    if not text:
        raise FetchError("couldn't extract readable article text from this page")

    text = " ".join(text.split())
    if len(text) > max_chars:
        text = text[:max_chars].rsplit(" ", 1)[0] + "…"
    return text
