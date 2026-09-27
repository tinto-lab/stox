import io

import pytest
from rich.console import Console

from stoxlib import rendering
from stoxlib.fundamentals import Fundamentals
from stoxlib.history import Bar
from stoxlib.news import Article
from stoxlib.quotes import Quote
from stoxlib.gnews import GeoArticle


def _quote(**overrides):
    defaults = dict(
        code="AAPL.US", price=227.14, change=3.04, percent=1.36,
        open_=225.0, high=228.0, low=224.5, prev_close=224.10,
        volume=50_000_000,
    )
    defaults.update(overrides)
    return Quote(**defaults)


def _bar(**overrides):
    defaults = dict(
        code="AAPL.US", date="2026-01-01", open_=225.0, high=228.0,
        low=224.5, close=227.14, volume=50_000_000,
    )
    defaults.update(overrides)
    return Bar(**defaults)


def _fundamentals(**overrides):
    defaults = dict(
        code="AAPL.US", name="Apple Inc.", sector="Technology",
        industry="Consumer Electronics", market_cap=4.85e12, pe_ratio=38.03,
        peg_ratio=2.66, profit_margin=0.2762, operating_margin=0.3262,
        roe=1.4875, roa=0.2708, ebitda=1.68e11, revenue_ttm=4.67e11,
        revenue_growth_yoy=0.164, earnings_growth_yoy=0.287, eps=8.74,
        dividend_yield=0.0032, analyst_target_price=327.20,
    )
    defaults.update(overrides)
    return Fundamentals(**defaults)


class _FakeAnalysisResult:
    def __init__(self, trend_text="Trending up.", fundamentals_text="Solid margins.",
                 news_text="Quiet week.", geopolitics_text="Limited exposure abroad.",
                 verdict_text="Low risk, favorable lean."):
        self.trend_text = trend_text
        self.fundamentals_text = fundamentals_text
        self.news_text = news_text
        self.geopolitics_text = geopolitics_text
        self.verdict_text = verdict_text


def _article(**overrides):
    defaults = dict(
        title="Apple hits new high", date="2026-01-01T12:00:00+00:00",
        link="https://example.com/a", symbols=["AAPL.US"],
        sentiment={"polarity": 0.9}, summary="Some summary.",
    )
    defaults.update(overrides)
    return Article(**defaults)


def _geo_article(**overrides):
    defaults = dict(
        title="Taiwan tightens chip export rules", date="2026-01-01T12:00:00+00:00",
        link="https://example.com/g", country="TW",
        sentiment="negative", summary="Some summary.",
    )
    defaults.update(overrides)
    return GeoArticle(**defaults)


@pytest.mark.parametrize("change, expected_color", [(1.0, "green"), (-1.0, "red"), (0.0, "white")])
def test_arrow_color(change, expected_color):
    _, color = rendering._arrow_color(change)
    assert color == expected_color


@pytest.mark.parametrize("volume, expected", [
    (1_500_000_000, "1.5B"),
    (2_000_000, "2.0M"),
    (3_000, "3.0K"),
    (42, "42"),
])
def test_fmt_vol(volume, expected):
    assert rendering._fmt_vol(volume) == expected


def _capturing_console():
    return Console(file=io.StringIO(), width=80, record=True)


def test_show_quote_includes_ticker_and_price():
    console = _capturing_console()
    rendering.show_quote(console, _quote())
    output = console.export_text()
    assert "AAPL" in output
    assert "227.14" in output
    assert "+1.36%" in output


def test_show_quotes_compact_includes_all_tickers():
    console = _capturing_console()
    quotes = [_quote(code="AAPL.US"), _quote(code="TSLA.US", change=-2.0, percent=-0.5)]
    rendering.show_quotes_compact(console, quotes)
    output = console.export_text()
    assert "AAPL.US" in output
    assert "TSLA.US" in output


def test_show_price_history_includes_ticker_and_bars():
    console = _capturing_console()
    bars = [_bar(date="2026-01-01", close=220.0), _bar(date="2026-01-02", close=227.14)]
    rendering.show_price_history(console, bars)
    output = console.export_text()
    assert "AAPL.US" in output
    assert "2026-01-01" in output
    assert "2026-01-02" in output
    assert "227.14" in output


def test_show_price_history_handles_empty_list():
    console = _capturing_console()
    rendering.show_price_history(console, [])
    assert "no historical data" in console.export_text()


def test_show_fundamentals_includes_metrics():
    console = _capturing_console()
    rendering.show_fundamentals(console, _fundamentals())
    output = console.export_text()
    assert "AAPL.US" in output
    assert "Apple Inc." in output
    assert "Technology" in output
    assert "+27.62%" in output  # profit margin


def test_show_fundamentals_handles_missing_fields():
    console = _capturing_console()
    rendering.show_fundamentals(console, _fundamentals(pe_ratio=None, dividend_yield=None))
    assert "n/a" in console.export_text()


def test_show_analysis_includes_all_five_texts():
    console = _capturing_console()
    rendering.show_analysis(console, _FakeAnalysisResult())
    output = console.export_text()
    assert "Trending up." in output
    assert "Solid margins." in output
    assert "Quiet week." in output
    assert "Limited exposure abroad." in output
    assert "Low risk, favorable lean." in output
    assert "not financial advice" in output


def test_show_analysis_does_not_let_verdict_be_parsed_as_markup():
    console = _capturing_console()
    rendering.show_analysis(console, _FakeAnalysisResult(verdict_text="[bold red]not a tag[/]"))
    assert "[bold red]not a tag[/]" in console.export_text()


@pytest.mark.parametrize("sentiment, expected_color", [
    ("positive", "green"), ("negative", "red"), ("neutral", "white"), (None, "white"),
])
def test_geo_sentiment_arrow(sentiment, expected_color):
    _, color = rendering._geo_sentiment_arrow(sentiment)
    assert color == expected_color


def test_show_geo_news_includes_title_country_and_link():
    console = _capturing_console()
    rendering.show_geo_news(console, [_geo_article()])
    output = console.export_text()
    assert "Taiwan tightens chip export rules" in output
    assert "TW" in output
    assert "https://example.com/g" in output


def test_show_geo_news_handles_empty_list():
    console = _capturing_console()
    rendering.show_geo_news(console, [])
    assert "no relevant world news" in console.export_text()


def test_show_geo_news_does_not_let_title_be_parsed_as_markup():
    console = _capturing_console()
    rendering.show_geo_news(console, [_geo_article(title="[bold red]not a tag[/]")])
    assert "[bold red]not a tag[/]" in console.export_text()


@pytest.mark.parametrize("sentiment, expected_color", [
    ({"polarity": 0.5}, "green"),
    ({"polarity": -0.5}, "red"),
    ({"polarity": 0.0}, "white"),
    ({}, "white"),
    (None, "white"),
])
def test_sentiment_arrow(sentiment, expected_color):
    _, color = rendering._sentiment_arrow(sentiment)
    assert color == expected_color


def test_show_news_lists_title_and_link():
    console = _capturing_console()
    rendering.show_news(console, [_article()])
    output = console.export_text()
    assert "Apple hits new high" in output
    assert "https://example.com/a" in output
    assert "2026-01-01" in output


def test_show_news_handles_empty_list():
    console = _capturing_console()
    rendering.show_news(console, [])
    assert "no recent news" in console.export_text()


def test_show_news_does_not_let_title_be_parsed_as_markup():
    """Titles are external content -- a stray '[' must render literally,
    never be interpreted as a Rich style tag."""
    console = _capturing_console()
    rendering.show_news(console, [_article(title="[bold red]not a style tag[/]")])
    output = console.export_text()
    assert "[bold red]not a style tag[/]" in output
