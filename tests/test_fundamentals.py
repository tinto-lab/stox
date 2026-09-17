from unittest.mock import Mock, patch

import pytest

from stoxlib import fundamentals


def _info(**overrides):
    data = {
        "symbol": "AAPL",
        "longName": "Apple Inc.",
        "sector": "Technology",
        "industry": "Consumer Electronics",
        "marketCap": 4_851_251_544_064,
        "trailingPE": 38.16418,
        "trailingPegRatio": 2.6605,
        "pegRatio": 2.67,
        "profitMargins": 0.27618998,
        "operatingMargins": 0.32623002,
        "returnOnEquity": 1.4875101,
        "returnOnAssets": 0.27082002,
        "ebitda": 167_959_003_136,
        "totalRevenue": 466_822_987_776,
        "revenueGrowth": 0.164,
        "earningsGrowth": 0.287,
        "trailingEps": 8.71,
        "dividendYield": 0.32,
        "targetMeanPrice": 327.1964,
    }
    data.update(overrides)
    return data


@pytest.mark.parametrize("ticker, expected", [
    ("aapl", "AAPL"),
    ("AAPL.US", "AAPL"),
    ("bmw.de", "BMW.DE"),
])
def test_yahoo_symbol_strips_only_the_us_suffix(ticker, expected):
    assert fundamentals._yahoo_symbol(ticker) == expected


def test_parse_returns_none_without_a_name():
    assert fundamentals._parse("AAPL", {"symbol": "AAPL"}) is None


def test_parse_builds_fundamentals():
    f = fundamentals._parse("AAPL", _info())
    assert f.code == "AAPL"
    assert f.name == "Apple Inc."
    assert f.sector == "Technology"
    assert f.industry == "Consumer Electronics"
    assert f.ebitda == 167_959_003_136
    assert f.profit_margin == 0.27618998
    assert f.pe_ratio == 38.16418
    assert f.eps == 8.71


def test_parse_prefers_trailing_peg_ratio_over_peg_ratio():
    f = fundamentals._parse("AAPL", _info())
    assert f.peg_ratio == 2.6605


def test_parse_falls_back_to_peg_ratio_when_trailing_is_missing():
    f = fundamentals._parse("AAPL", _info(trailingPegRatio=None))
    assert f.peg_ratio == 2.67


def test_parse_converts_dividend_yield_from_percentage_points_to_a_fraction():
    """Regression: yfinance reports dividendYield as e.g. 0.32 meaning
    0.32%, not a 0.0032 fraction like the rest of these fields -- the
    stored value must be normalized to a fraction like everything else, or
    rendering's percent formatter would show 32% instead of 0.32%."""
    f = fundamentals._parse("AAPL", _info())
    assert f.dividend_yield == pytest.approx(0.0032)


def test_parse_leaves_dividend_yield_none_when_missing():
    f = fundamentals._parse("AAPL", _info(dividendYield=None))
    assert f.dividend_yield is None


def test_parse_falls_back_to_short_name():
    f = fundamentals._parse("AAPL", _info(longName=None, shortName="Apple"))
    assert f.name == "Apple"


def test_parse_defaults_missing_optional_fields_to_none_or_empty():
    f = fundamentals._parse("AAPL", {"longName": "Apple Inc."})
    assert f.sector == ""
    assert f.industry == ""
    assert f.market_cap is None
    assert f.ebitda is None
    assert f.peg_ratio is None


def test_fetch_fundamentals_uses_the_yahoo_symbol(monkeypatch):
    mock_ticker = Mock()
    mock_ticker.info = _info()
    with patch("yfinance.Ticker", return_value=mock_ticker) as mock_cls:
        f = fundamentals.fetch_fundamentals("aapl")

    mock_cls.assert_called_once_with("AAPL")
    assert f.code == "AAPL"
    assert f.name == "Apple Inc."


def test_fetch_fundamentals_unknown_symbol_raises(monkeypatch):
    mock_ticker = Mock()
    mock_ticker.info = {"trailingPegRatio": None}  # yfinance's shape for an unknown symbol
    with patch("yfinance.Ticker", return_value=mock_ticker):
        with pytest.raises(fundamentals.FundamentalsError, match="unknown symbol"):
            fundamentals.fetch_fundamentals("ZZZZNOPE")


def test_fetch_fundamentals_wraps_any_exception_from_yfinance(monkeypatch):
    with patch("yfinance.Ticker", side_effect=RuntimeError("boom")):
        with pytest.raises(fundamentals.FundamentalsError, match="couldn't fetch fundamentals"):
            fundamentals.fetch_fundamentals("AAPL")


def test_fetch_fundamentals_non_dict_info_raises(monkeypatch):
    mock_ticker = Mock()
    mock_ticker.info = None
    with patch("yfinance.Ticker", return_value=mock_ticker):
        with pytest.raises(fundamentals.FundamentalsError, match="couldn't parse"):
            fundamentals.fetch_fundamentals("AAPL")
