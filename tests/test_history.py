from unittest.mock import Mock, patch

import pytest
import requests

from stoxlib import history


def test_parse_returns_none_without_close():
    assert history._parse("AAPL.US", {"date": "2026-01-01"}) is None


def test_parse_returns_none_without_date():
    assert history._parse("AAPL.US", {"close": "227.14"}) is None


def test_parse_builds_bar():
    b = history._parse("AAPL.US", {
        "date": "2026-01-01", "open": "225.0", "high": "228.0",
        "low": "224.5", "close": "227.14", "volume": "50000000",
    })
    assert b.code == "AAPL.US"
    assert b.date == "2026-01-01"
    assert b.open == 225.0
    assert b.high == 228.0
    assert b.low == 224.5
    assert b.close == 227.14
    assert b.volume == 50000000


def test_parse_defaults_missing_optional_fields_to_zero():
    b = history._parse("AAPL.US", {"date": "2026-01-01", "close": "227.14"})
    assert b.open == 0.0
    assert b.high == 0.0
    assert b.low == 0.0
    assert b.volume == 0.0


def test_fetch_history_without_key_raises(monkeypatch):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    with pytest.raises(history.HistoryError, match="no API key"):
        history.fetch_history("AAPL")


def test_fetch_history_parses_list_response(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = [
        {"date": "2026-01-01", "open": "225.0", "high": "228.0",
         "low": "224.5", "close": "227.14", "volume": "50000000"},
        {"date": "2026-01-02"},  # no close -- dropped
    ]
    with patch("stoxlib.history.requests.get", return_value=response) as mock_get:
        bars = history.fetch_history("AAPL", days=10)

    assert len(bars) == 1
    assert bars[0].code == "AAPL.US"
    assert mock_get.call_args.args[0] == "%s/eod/AAPL.US" % history.EODHD_URL
    params = mock_get.call_args.kwargs["params"]
    assert params["period"] == "d"
    assert "from" in params and "to" in params


def test_fetch_history_single_object_response(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = {"date": "2026-01-01", "close": "227.14"}
    with patch("stoxlib.history.requests.get", return_value=response):
        bars = history.fetch_history("AAPL")

    assert len(bars) == 1


def test_fetch_history_falls_back_to_daily_on_unknown_period(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.return_value = []
    with patch("stoxlib.history.requests.get", return_value=response) as mock_get:
        history.fetch_history("AAPL", period="bogus")

    assert mock_get.call_args.kwargs["params"]["period"] == "d"


@pytest.mark.parametrize("status_code", [401, 403])
def test_fetch_history_access_denied(monkeypatch, status_code):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=status_code)
    with patch("stoxlib.history.requests.get", return_value=response):
        with pytest.raises(history.HistoryError, match="access denied"):
            history.fetch_history("AAPL")


def test_fetch_history_other_http_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=500)
    with patch("stoxlib.history.requests.get", return_value=response):
        with pytest.raises(history.HistoryError, match="HTTP 500"):
            history.fetch_history("AAPL")


def test_fetch_history_bad_json(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    response = Mock(status_code=200)
    response.json.side_effect = ValueError("boom")
    with patch("stoxlib.history.requests.get", return_value=response):
        with pytest.raises(history.HistoryError, match="couldn't parse"):
            history.fetch_history("AAPL")


def test_fetch_history_network_error(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    with patch("stoxlib.history.requests.get",
               side_effect=requests.ConnectionError("down")):
        with pytest.raises(history.HistoryError, match="network error"):
            history.fetch_history("AAPL")
