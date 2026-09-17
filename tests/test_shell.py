import io
from unittest.mock import patch

import pytest
from rich.console import Console

from stoxlib import shell
from stoxlib.agent import AgentResult
from stoxlib.quotes import Quote, QuoteError


@pytest.fixture
def test_console(monkeypatch):
    """Swap the module-level console for one we can inspect."""
    console = Console(file=io.StringIO(), width=80, record=True)
    monkeypatch.setattr(shell, "console", console)
    return console


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


@pytest.mark.parametrize("text, expected", [
    ("AAPL", False),
    ("TSLA MSFT NVDA", False),
    ("BTC-USD.CC", False),
    ("what is the price of apple stock today?", True),
    ("what's apple trading at", True),
    ("how much is tesla worth", True),
])
def test_looks_like_query(text, expected):
    assert shell._looks_like_query(text) is expected


def test_handle_command_quit_signals_stop(test_console):
    assert shell.handle_command("/quit") is False
    assert "bye" in test_console.export_text()


def test_handle_command_help_shows_help_text(test_console):
    assert shell.handle_command("/help") is True
    assert "commands" in test_console.export_text()


def test_handle_command_unknown_reports_error(test_console):
    assert shell.handle_command("/bogus") is True
    assert "unknown command" in test_console.export_text()


def test_handle_tickers_success(test_console):
    with patch("stoxlib.shell.fetch_quotes", return_value=([_quote()], [])):
        shell.handle_tickers("AAPL")
    output = test_console.export_text()
    assert "227.14" in output


def test_handle_tickers_reports_missing(test_console):
    with patch("stoxlib.shell.fetch_quotes", return_value=([], ["NOPE.US"])):
        shell.handle_tickers("NOPE")
    assert "no data" in test_console.export_text()


def test_handle_tickers_reports_quote_error(test_console):
    with patch("stoxlib.shell.fetch_quotes", side_effect=QuoteError("access denied")):
        shell.handle_tickers("AAPL")
    assert "access denied" in test_console.export_text()


def test_handle_query_shows_provider_and_answer(test_console, monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "deepseek")
    result = AgentResult(text="Apple is up today.", quotes=[_quote()])
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("what is apple trading at?")
    output = test_console.export_text()
    assert "deepseek" in output
    assert "Apple is up today." in output
    assert "227.14" in output


def test_handle_query_reports_error(test_console):
    result = AgentResult(error="no ANTHROPIC_API_KEY set -- see /help")
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("what is apple trading at?")
    assert "no ANTHROPIC_API_KEY set" in test_console.export_text()


def test_main_routes_input_and_stops_on_quit(test_console, monkeypatch):
    """A light integration test: canned input lines should dispatch to the
    right handler, and /quit should end the loop cleanly."""
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    inputs = iter(["AAPL", "what is apple trading at?", "/quit"])
    monkeypatch.setattr(shell.console, "input", lambda *_args, **_kwargs: next(inputs))

    calls = []
    monkeypatch.setattr(shell, "handle_tickers", lambda text: calls.append(("tickers", text)))
    monkeypatch.setattr(shell, "handle_query", lambda text: calls.append(("query", text)))

    shell.main()

    assert calls == [
        ("tickers", "AAPL"),
        ("query", "what is apple trading at?"),
    ]


def test_main_stops_cleanly_on_eof(test_console, monkeypatch):
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    def _raise_eof(*_args, **_kwargs):
        raise EOFError

    monkeypatch.setattr(shell.console, "input", _raise_eof)

    shell.main()  # should return, not raise
    assert "bye" in test_console.export_text()
