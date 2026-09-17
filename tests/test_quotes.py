from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import quotes


def test_normalize_adds_us_suffix():
    assert quotes.normalize("aapl") == "AAPL.US"


def test_normalize_keeps_explicit_exchange():
    assert quotes.normalize("bmw.xetra") == "BMW.XETRA"


def test_normalize_uppercases():
    assert quotes.normalize("btc-usd.cc") == "BTC-USD.CC"


@pytest.mark.parametrize("value, expected", [
    ("1.5", 1.5),
    (2, 2.0),
    ("NA", None),
    (None, None),
    ("", None),
])
def test_num_coerces_or_returns_none(value, expected):
    assert quotes._num(value) == expected


def test_parse_returns_none_without_close():
    assert quotes._parse({"code": "AAPL.US"}) is None


def test_parse_builds_quote():
    q = quotes._parse({
        "code": "AAPL.US", "close": "227.14", "change": "3.04",
        "change_p": "1.36", "open": "225.0", "high": "228.0", "low": "224.5",
        "previousClose": "224.10", "volume": "50000000",
    })
    assert q.code == "AAPL.US"
    assert q.price == 227.14
    assert q.change == 3.04
    assert q.percent == 1.36
    assert q.prev_close == 224.10
    assert q.volume == 50000000


def test_parse_defaults_missing_optional_fields_to_zero():
    q = quotes._parse({"code": "AAPL.US", "close": "227.14"})
    assert q.change == 0.0
    assert q.percent == 0.0
    assert q.volume == 0.0


def test_api_key_reads_env_on_every_call(monkeypatch):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    assert quotes.api_key() == ""
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    assert quotes.api_key() == "demo"


def test_fetch_quotes_without_key_raises(monkeypatch):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    with pytest.raises(quotes.QuoteError, match="no API key"):
        quotes.fetch_quotes(["AAPL"])


def test_fetch_quotes_parses_found_and_missing(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = [
        {"code": "AAPL.US", "close": "227.14", "change": "3.04", "change_p": "1.36"},
    ]
    with patch("stoxlib.quotes.requests.get", return_value=response) as mock_get:
        found, missing = quotes.fetch_quotes(["AAPL", "NOPE"])

    assert len(found) == 1
    assert found[0].code == "AAPL.US"
    assert missing == ["NOPE.US"]
    mock_get.assert_called_once()


def test_fetch_quotes_single_object_response(monkeypatch):
    """EODHD returns a bare object (not a list) for a single ticker."""
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {"code": "AAPL.US", "close": "227.14"}
    with patch("stoxlib.quotes.requests.get", return_value=response):
        found, missing = quotes.fetch_quotes(["AAPL"])

    assert len(found) == 1
    assert missing == []


@pytest.mark.parametrize("status_code", [401, 403])
def test_fetch_quotes_access_denied(monkeypatch, status_code):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=status_code)
    with patch("stoxlib.quotes.requests.get", return_value=response):
        with pytest.raises(quotes.QuoteError, match="access denied"):
            quotes.fetch_quotes(["AAPL"])


def test_fetch_quotes_other_http_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=500)
    with patch("stoxlib.quotes.requests.get", return_value=response):
        with pytest.raises(quotes.QuoteError, match="HTTP 500"):
            quotes.fetch_quotes(["AAPL"])


def test_fetch_quotes_bad_json(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.side_effect = ValueError("boom")
    with patch("stoxlib.quotes.requests.get", return_value=response):
        with pytest.raises(quotes.QuoteError, match="couldn't parse"):
            quotes.fetch_quotes(["AAPL"])


def test_fetch_quotes_network_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    with patch("stoxlib.quotes.requests.get",
               side_effect=requests.ConnectionError("down")):
        with pytest.raises(quotes.QuoteError, match="network error"):
            quotes.fetch_quotes(["AAPL"])
