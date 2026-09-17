import io

import pytest
from rich.console import Console

from stoxlib import rendering
from stoxlib.news import Article
from stoxlib.quotes import Quote


def _quote(**overrides):
    defaults = dict(
        code="AAPL.US", price=227.14, change=3.04, percent=1.36,
        open_=225.0, high=228.0, low=224.5, prev_close=224.10,
        volume=50_000_000,
    )
    defaults.update(overrides)
    return Quote(**defaults)


def _article(**overrides):
    defaults = dict(
        title="Apple hits new high", date="2026-01-01T12:00:00+00:00",
        link="https://example.com/a", symbols=["AAPL.US"],
        sentiment={"polarity": 0.9}, summary="Some summary.",
    )
    defaults.update(overrides)
    return Article(**defaults)


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
