from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import news


def test_truncate_leaves_short_text_alone():
    assert news._truncate("short text", limit=240) == "short text"


def test_truncate_collapses_whitespace():
    assert news._truncate("a\n\nb   c", limit=240) == "a b c"


def test_truncate_cuts_long_text_at_a_word_boundary():
    text = "word " * 100
    result = news._truncate(text, limit=20)
    assert len(result) <= 21  # 20 + the ellipsis character
    assert result.endswith("…")
    assert not result[:-1].endswith(" ")


def test_parse_returns_none_without_title():
    assert news._parse({"date": "2026-01-01T00:00:00+00:00"}) is None


def test_parse_builds_article():
    a = news._parse({
        "title": "Apple hits new high",
        "date": "2026-01-01T12:00:00+00:00",
        "link": "https://example.com/a",
        "symbols": ["AAPL.US"],
        "sentiment": {"polarity": 0.9},
        "content": "Some article body text.",
    })
    assert a.title == "Apple hits new high"
    assert a.date == "2026-01-01T12:00:00+00:00"
    assert a.link == "https://example.com/a"
    assert a.symbols == ["AAPL.US"]
    assert a.sentiment == {"polarity": 0.9}
    assert a.summary == "Some article body text."


def test_parse_defaults_missing_optional_fields():
    a = news._parse({"title": "headline only"})
    assert a.symbols == []
    assert a.sentiment == {}
    assert a.summary == ""


def test_fetch_news_without_key_raises(monkeypatch):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    with pytest.raises(news.NewsError, match="no API key"):
        news.fetch_news(["AAPL"])


def test_fetch_news_parses_list_response(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = [
        {"title": "Apple hits new high", "date": "2026-01-01T00:00:00+00:00",
         "link": "https://example.com/a", "symbols": ["AAPL.US"]},
        {"date": "2026-01-01T00:00:00+00:00"},  # no title -- dropped
    ]
    with patch("stoxlib.news.requests.get", return_value=response) as mock_get:
        articles = news.fetch_news(["AAPL"], limit=5)

    assert len(articles) == 1
    assert articles[0].title == "Apple hits new high"
    called_params = mock_get.call_args.kwargs["params"]
    assert called_params["s"] == "AAPL.US"
    assert called_params["limit"] == 5


@pytest.mark.parametrize("status_code", [401, 403])
def test_fetch_news_access_denied(monkeypatch, status_code):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=status_code)
    with patch("stoxlib.news.requests.get", return_value=response):
        with pytest.raises(news.NewsError, match="access denied"):
            news.fetch_news(["AAPL"])


def test_fetch_news_other_http_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=500)
    with patch("stoxlib.news.requests.get", return_value=response):
        with pytest.raises(news.NewsError, match="HTTP 500"):
            news.fetch_news(["AAPL"])


def test_fetch_news_bad_json(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.side_effect = ValueError("boom")
    with patch("stoxlib.news.requests.get", return_value=response):
        with pytest.raises(news.NewsError, match="couldn't parse"):
            news.fetch_news(["AAPL"])


def test_fetch_news_network_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    with patch("stoxlib.news.requests.get",
               side_effect=requests.ConnectionError("down")):
        with pytest.raises(news.NewsError, match="network error"):
            news.fetch_news(["AAPL"])
