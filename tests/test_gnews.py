import json
from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import gnews, tools
from stoxlib.gnews import GeoArticle, GNewsError

REDIRECT = "https://news.google.com/rss/articles/CBMiABC?oc=5"

FEED = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item>
  <title>Taiwan tightens chip export rules - Reuters</title>
  <link>https://news.google.com/rss/articles/CBMiABC?oc=5</link>
  <pubDate>Thu, 24 Sep 2026 06:38:16 GMT</pubDate>
  <source url="https://www.reuters.com">Reuters</source>
</item>
<item><link>https://news.google.com/rss/articles/NOTITLE</link></item>
<item>
  <title>Fed holds rates</title>
  <link>https://news.google.com/rss/articles/CBMiDEF</link>
  <pubDate>not a date</pubDate>
</item>
</channel></rss>"""


@pytest.fixture(autouse=True)
def clear_gnews_cache():
    gnews._cache.clear()


def _feed_response(content=FEED, status=200):
    return Mock(status_code=status, content=content)


def _item(xml):
    from xml.etree import ElementTree
    return ElementTree.fromstring(xml)


def test_parse_strips_publisher_suffix_and_converts_date():
    a = gnews._parse(_item(
        "<item><title>Chips curbs widen - Politico</title><link>%s</link>"
        "<pubDate>Thu, 24 Sep 2026 14:51:00 GMT</pubDate>"
        "<source url='https://politico.com'>Politico</source></item>" % REDIRECT))
    assert a.title == "Chips curbs widen"
    assert a.date == "2026-09-24T14:51:00+00:00"
    assert a.link == REDIRECT
    assert a.country == ""
    assert a.sentiment == ""
    assert a.summary == "(headline only, from Politico)"


def test_parse_returns_none_without_title():
    assert gnews._parse(_item("<item><link>x</link></item>")) is None


def test_parse_keeps_unparseable_date_as_is():
    a = gnews._parse(_item("<item><title>t</title><pubDate>garbage</pubDate></item>"))
    assert a.date == "garbage"
    assert a.summary == ""


def test_decode_link_resolves_publisher_url():
    page = Mock(text='<div data-n-a-sg="SIG" data-n-a-ts="1758700000"></div>')
    inner = json.dumps(["garturlres", "https://www.reuters.com/world/chips", 1])
    batch = Mock(text=")]}'\n\n" + json.dumps([["wrb.fr", "Fbv4je", inner]]))
    with patch("stoxlib.gnews.requests.get", return_value=page) as mock_get, \
         patch("stoxlib.gnews.requests.post", return_value=batch) as mock_post:
        assert gnews._decode_link(REDIRECT) == "https://www.reuters.com/world/chips"

    assert mock_get.call_args[0][0] == gnews.ARTICLE_URL + "CBMiABC"
    sent = json.loads(json.loads(mock_post.call_args[1]["data"]["f.req"])[0][0][1])
    assert sent[-3:] == ["CBMiABC", 1758700000, "SIG"]


def test_decode_link_returns_none_without_signature():
    with patch("stoxlib.gnews.requests.get", return_value=Mock(text="<html></html>")):
        assert gnews._decode_link(REDIRECT) is None


def test_decode_link_returns_none_on_garbled_response():
    page = Mock(text='data-n-a-sg="S" data-n-a-ts="1"')
    with patch("stoxlib.gnews.requests.get", return_value=page), \
         patch("stoxlib.gnews.requests.post", return_value=Mock(text="nope")):
        assert gnews._decode_link(REDIRECT) is None


def test_decode_link_returns_none_on_network_error():
    with patch("stoxlib.gnews.requests.get", side_effect=requests.ConnectionError("down")):
        assert gnews._decode_link(REDIRECT) is None


def test_decode_link_ignores_non_google_links():
    assert gnews._decode_link("https://example.com/a") is None


def test_fetch_geo_news_parses_feed_and_decodes_links():
    def decode(link):
        return "https://www.reuters.com/a" if "CBMiABC" in link else None

    with patch("stoxlib.gnews.requests.get", return_value=_feed_response()) as mock_get, \
         patch("stoxlib.gnews._decode_link", side_effect=decode):
        articles = gnews.fetch_geo_news("Taiwan chip export controls", limit=5)

    assert [a.title for a in articles] == ["Taiwan tightens chip export rules", "Fed holds rates"]
    assert articles[0].link == "https://www.reuters.com/a"
    # Decoding failed for this one -- it keeps the redirect link.
    assert articles[1].link == "https://news.google.com/rss/articles/CBMiDEF"
    params = mock_get.call_args[1]["params"]
    assert params["q"] == "(Taiwan chip export controls) when:7d"
    assert params["hl"] == "en-US"


def test_fetch_geo_news_respects_limit():
    with patch("stoxlib.gnews.requests.get", return_value=_feed_response()), \
         patch("stoxlib.gnews._decode_link", return_value=None) as mock_decode:
        articles = gnews.fetch_geo_news("query", limit=1)

    assert len(articles) == 1
    assert mock_decode.call_count == 1


def test_fetch_geo_news_empty_feed_returns_empty_list():
    empty = b"<rss><channel></channel></rss>"
    with patch("stoxlib.gnews.requests.get", return_value=_feed_response(empty)):
        assert gnews.fetch_geo_news("obscure") == []


def test_fetch_geo_news_caches_results():
    with patch("stoxlib.gnews.requests.get", return_value=_feed_response()) as mock_get, \
         patch("stoxlib.gnews._decode_link", return_value=None):
        first = gnews.fetch_geo_news("query")
        second = gnews.fetch_geo_news("query")

    assert first == second
    assert mock_get.call_count == 1


def test_fetch_geo_news_network_error_raises():
    with patch("stoxlib.gnews.requests.get", side_effect=requests.ConnectionError("down")):
        with pytest.raises(GNewsError, match="network error"):
            gnews.fetch_geo_news("query")


def test_fetch_geo_news_http_error_raises():
    with patch("stoxlib.gnews.requests.get", return_value=_feed_response(status=503)):
        with pytest.raises(GNewsError, match="HTTP 503"):
            gnews.fetch_geo_news("query")


def test_fetch_geo_news_bad_xml_raises():
    with patch("stoxlib.gnews.requests.get", return_value=_feed_response(b"<html>")):
        with pytest.raises(GNewsError, match="parse"):
            gnews.fetch_geo_news("query")


def test_run_geo_news_tool_surfaces_google_error():
    with patch("stoxlib.tools.fetch_geo_news", side_effect=GNewsError("server returned HTTP 503")):
        text, articles = tools.run_geo_news_tool("q")

    assert text == "error: server returned HTTP 503"
    assert articles == []



def test_is_redirect_link():
    assert gnews.is_redirect_link(REDIRECT)
    assert not gnews.is_redirect_link("https://www.reuters.com/a")
    assert not gnews.is_redirect_link("")


def test_run_geo_news_tool_skips_body_fetch_for_undecoded_links():
    article = GeoArticle("Fed holds rates", "", REDIRECT, "", "", "(headline only, from Reuters)")
    with patch("stoxlib.tools.fetch_geo_news", return_value=[article]), \
         patch("stoxlib.tools.fetch_article_text") as fetch:
        text, _ = tools.run_geo_news_tool("q")

    fetch.assert_not_called()
    assert "(headline only, from Reuters)" in text
