from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import webfetch


@pytest.mark.parametrize("bad_url", ["", "not-a-url", "ftp://example.com/a"])
def test_fetch_article_text_rejects_non_http_urls(bad_url):
    with pytest.raises(webfetch.FetchError, match="not a valid"):
        webfetch.fetch_article_text(bad_url)


def test_fetch_article_text_network_error():
    with patch("stoxlib.webfetch.requests.get",
               side_effect=requests.ConnectionError("down")):
        with pytest.raises(webfetch.FetchError, match="network error"):
            webfetch.fetch_article_text("https://example.com/a")


def test_fetch_article_text_http_error():
    response = Mock(status_code=404)
    with patch("stoxlib.webfetch.requests.get", return_value=response):
        with pytest.raises(webfetch.FetchError, match="HTTP 404"):
            webfetch.fetch_article_text("https://example.com/a")


def test_fetch_article_text_extracts_and_returns_text():
    response = Mock(status_code=200, text="<html><body><p>hello world</p></body></html>")
    with patch("stoxlib.webfetch.requests.get", return_value=response), \
         patch("stoxlib.webfetch.trafilatura.extract", return_value="hello world"):
        text = webfetch.fetch_article_text("https://example.com/a")
    assert text == "hello world"


def test_fetch_article_text_raises_when_nothing_extractable():
    response = Mock(status_code=200, text="<html></html>")
    with patch("stoxlib.webfetch.requests.get", return_value=response), \
         patch("stoxlib.webfetch.trafilatura.extract", return_value=None):
        with pytest.raises(webfetch.FetchError, match="couldn't extract"):
            webfetch.fetch_article_text("https://example.com/a")


def test_fetch_article_text_truncates_long_text():
    long_text = "word " * 2000
    response = Mock(status_code=200, text="<html></html>")
    with patch("stoxlib.webfetch.requests.get", return_value=response), \
         patch("stoxlib.webfetch.trafilatura.extract", return_value=long_text):
        text = webfetch.fetch_article_text("https://example.com/a", max_chars=50)
    assert len(text) <= 51  # 50 + the ellipsis character
    assert text.endswith("…")
