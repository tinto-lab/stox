from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import webz


@pytest.fixture(autouse=True)
def clear_webz_cache():
    """Several tests below reuse the same query string ("query") expecting
    a fresh HTTP call and independent error handling each time -- without
    this, the first successful call would cache a result the later tests
    would get back instead of ever hitting requests.get."""
    webz._cache.clear()


def test_truncate_leaves_short_text_alone():
    assert webz._truncate("short text", limit=240) == "short text"


def test_truncate_collapses_whitespace():
    assert webz._truncate("a\n\nb   c", limit=240) == "a b c"


def test_truncate_cuts_long_text_at_a_word_boundary():
    text = "word " * 100
    result = webz._truncate(text, limit=20)
    assert len(result) <= 21  # 20 + the ellipsis character
    assert result.endswith("…")
    assert not result[:-1].endswith(" ")


def test_parse_returns_none_without_title():
    assert webz._parse({"published": "2026-01-01T00:00:00+00:00"}) is None


def test_parse_builds_geo_article():
    a = webz._parse({
        "title": "Taiwan tightens chip export rules",
        "published": "2026-01-01T12:00:00+00:00",
        "url": "https://example.com/a",
        "thread": {"country": "TW"},
        "sentiment": "negative",
        "text": "Some article body text.",
    })
    assert a.title == "Taiwan tightens chip export rules"
    assert a.date == "2026-01-01T12:00:00+00:00"
    assert a.link == "https://example.com/a"
    assert a.country == "TW"
    assert a.sentiment == "negative"
    assert a.summary == "Some article body text."


def test_parse_defaults_missing_optional_fields():
    a = webz._parse({"title": "headline only"})
    assert a.country == ""
    assert a.sentiment == ""
    assert a.summary == ""


def test_fetch_geo_news_without_key_raises(monkeypatch):
    monkeypatch.delenv("WEBZ_API_KEY", raising=False)
    with pytest.raises(webz.WebzError, match="no API key"):
        webz.fetch_geo_news("tariffs")


def test_fetch_geo_news_parses_posts_response(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {
        "posts": [
            {"title": "Taiwan tightens chip export rules",
             "published": "2026-01-01T00:00:00+00:00",
             "url": "https://example.com/a", "thread": {"country": "TW"}},
            {"published": "2026-01-01T00:00:00+00:00"},  # no title -- dropped
        ],
    }
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get:
        articles = webz.fetch_geo_news("Taiwan chip export controls", limit=5)

    assert len(articles) == 1
    assert articles[0].title == "Taiwan tightens chip export rules"
    called_params = mock_get.call_args.kwargs["params"]
    assert called_params["q"] == "Taiwan chip export controls"
    assert called_params["token"] == "demo"


def test_fetch_geo_news_sends_size_matching_limit(monkeypatch):
    """size controls how many posts the API returns (and bills for), so it
    should track `limit` instead of defaulting to a full, fully-billed page."""
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {
        "posts": [{"title": "Article %d" % i, "url": "https://example.com/%d" % i}
                  for i in range(10)],
    }
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get:
        articles = webz.fetch_geo_news("query", limit=3)

    assert len(articles) == 3
    assert mock_get.call_args.kwargs["params"]["size"] == 3


def test_fetch_geo_news_clamps_size_to_the_api_max(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {"posts": []}
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get:
        webz.fetch_geo_news("query", limit=500)

    assert mock_get.call_args.kwargs["params"]["size"] == webz._MAX_SIZE


def test_fetch_geo_news_caches_repeat_queries(monkeypatch):
    """A second call with the same (query, limit) shouldn't hit the API
    again -- this is what protects the search budget when a specialist
    tries overlapping angles, or re-analyzes the same ticker soon after."""
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {
        "posts": [{"title": "Cached article", "url": "https://example.com/a"}],
    }
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get:
        first = webz.fetch_geo_news("Taiwan tariffs", limit=5)
        second = webz.fetch_geo_news("Taiwan tariffs", limit=5)

    assert first == second
    mock_get.assert_called_once()


def test_fetch_geo_news_cache_expires_after_ttl(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {
        "posts": [{"title": "Fresh article", "url": "https://example.com/a"}],
    }
    times = iter([0.0, webz._CACHE_TTL_SECONDS + 1, webz._CACHE_TTL_SECONDS + 1])
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get, \
         patch("stoxlib.webz.time.monotonic", side_effect=lambda: next(times)):
        webz.fetch_geo_news("query", limit=5)
        webz.fetch_geo_news("query", limit=5)

    assert mock_get.call_count == 2


def test_fetch_geo_news_does_not_cache_a_different_limit(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {
        "posts": [{"title": "Article", "url": "https://example.com/a"}],
    }
    with patch("stoxlib.webz.requests.get", return_value=response) as mock_get:
        webz.fetch_geo_news("query", limit=5)
        webz.fetch_geo_news("query", limit=10)

    assert mock_get.call_count == 2


def test_fetch_geo_news_handles_non_dict_response(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = []
    with patch("stoxlib.webz.requests.get", return_value=response):
        assert webz.fetch_geo_news("query") == []


@pytest.mark.parametrize("status_code", [401, 403])
def test_fetch_geo_news_access_denied(monkeypatch, status_code):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=status_code)
    with patch("stoxlib.webz.requests.get", return_value=response):
        with pytest.raises(webz.WebzError, match="access denied"):
            webz.fetch_geo_news("query")


def test_fetch_geo_news_other_http_error(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=500)
    with patch("stoxlib.webz.requests.get", return_value=response):
        with pytest.raises(webz.WebzError, match="HTTP 500"):
            webz.fetch_geo_news("query")


def test_fetch_geo_news_bad_json(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.side_effect = ValueError("boom")
    with patch("stoxlib.webz.requests.get", return_value=response):
        with pytest.raises(webz.WebzError, match="couldn't parse"):
            webz.fetch_geo_news("query")


def test_fetch_geo_news_network_error(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    with patch("stoxlib.webz.requests.get",
               side_effect=requests.ConnectionError("down")):
        with pytest.raises(webz.WebzError, match="network error"):
            webz.fetch_geo_news("query")


# -- rate limiting (429) -----------------------------------------------------

def test_fetch_geo_news_retries_after_rate_limit_then_succeeds(monkeypatch):
    """A single 429 shouldn't surface as an error -- it should retry and
    return the eventual successful result, since this plan's rate limit
    clears within a couple seconds (see _RATE_LIMIT_RETRIES's docstring)."""
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    rate_limited = Mock(status_code=429, headers={})
    success = Mock(status_code=200, headers={})
    success.json.return_value = {"posts": [{"title": "Got through", "url": "https://example.com/a"}]}

    with patch("stoxlib.webz.requests.get", side_effect=[rate_limited, success]), \
         patch("stoxlib.webz.time.sleep") as mock_sleep:
        articles = webz.fetch_geo_news("query")

    assert len(articles) == 1
    assert articles[0].title == "Got through"
    mock_sleep.assert_called_once()


def test_fetch_geo_news_raises_after_exhausting_retries(monkeypatch):
    monkeypatch.setenv("WEBZ_API_KEY", "demo")
    rate_limited = Mock(status_code=429, headers={})

    with patch("stoxlib.webz.requests.get", return_value=rate_limited) as mock_get, \
         patch("stoxlib.webz.time.sleep"):
        with pytest.raises(webz.WebzError, match="rate limited"):
            webz.fetch_geo_news("query")

    assert mock_get.call_count == webz._RATE_LIMIT_RETRIES + 1


def test_retry_delay_honors_retry_after_header():
    response = Mock(headers={"Retry-After": "7"})
    assert webz._retry_delay(response, attempt=0) == 7.0


def test_retry_delay_falls_back_to_exponential_backoff_without_header():
    response = Mock(headers={})
    assert webz._retry_delay(response, attempt=0) == webz._RATE_LIMIT_BACKOFF
    assert webz._retry_delay(response, attempt=1) == webz._RATE_LIMIT_BACKOFF * 2
