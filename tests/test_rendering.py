import io

import pytest
from rich.console import Console

from stoxlib import rendering
from stoxlib.quotes import Quote


def _quote(**overrides):
    defaults = dict(
        code="AAPL.US", price=227.14, change=3.04, percent=1.36,
        open_=225.0, high=228.0, low=224.5, prev_close=224.10,
        volume=50_000_000,
    )
    defaults.update(overrides)
    return Quote(**defaults)


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
