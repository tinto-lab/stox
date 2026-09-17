import io
import re
from unittest.mock import patch

import pytest
from rich.console import Console

from stoxlib import considerations, shell
from stoxlib.agent import AgentResult
from stoxlib.news import Article
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


def test_prompt_string_brackets_ansi_codes_for_readline(monkeypatch):
    """Regression test for a real line-editing bug: an unbracketed ANSI
    prompt made readline miscount the prompt's on-screen width, which let
    word-delete eat into the prompt and broke cursor movement (couldn't
    get back to end-of-line after jumping to the start). Every escape
    sequence in the prompt must be wrapped in \\001 ... \\002 so readline
    knows those bytes are invisible."""
    colored_console = Console(file=io.StringIO(), force_terminal=True, color_system="standard")
    monkeypatch.setattr(shell, "console", colored_console)

    prompt = shell._prompt_string("[bold cyan]›[/] ")

    assert "\x1b[" in prompt  # sanity: color codes were actually emitted
    assert "›" in prompt

    for m in re.finditer(r"\x1b\[[0-9;]*m", prompt):
        start, end = m.span()
        assert prompt[start - 1] == "\x01", "escape sequence missing RL_PROMPT_START_IGNORE"
        assert prompt[end] == "\x02", "escape sequence missing RL_PROMPT_END_IGNORE"

    # the visible arrow itself must NOT be swallowed inside a \x01..\x02 span
    visible_index = prompt.index("›")
    assert prompt[visible_index - 1] != "\x01"


def test_handle_command_quit_signals_stop(test_console):
    assert shell.handle_command("/quit", []) is False
    assert "bye" in test_console.export_text()


def test_handle_command_help_shows_help_text(test_console):
    assert shell.handle_command("/help", []) is True
    assert "commands" in test_console.export_text()


def test_handle_command_unknown_reports_error(test_console):
    assert shell.handle_command("/bogus", []) is True
    assert "unknown command" in test_console.export_text()


@pytest.mark.parametrize("cmd", ["/reset", "/new"])
def test_handle_command_reset_clears_history(test_console, cmd):
    from langchain_core.messages import HumanMessage

    history = [HumanMessage(content="what is apple trading at?")]
    assert shell.handle_command(cmd, history) is True
    assert history == []
    assert "forgotten" in test_console.export_text()


@pytest.mark.parametrize("cmd", ["/considerations", "/remembered"])
def test_handle_command_considerations_lists_stored_items(test_console, cmd):
    considerations.add_consideration("always factor in insider selling")
    assert shell.handle_command(cmd, []) is True
    output = test_console.export_text()
    assert "always factor in insider selling" in output


def test_handle_command_considerations_reports_when_empty(test_console):
    assert shell.handle_command("/considerations", []) is True
    assert "no standing considerations yet" in test_console.export_text()


def test_handle_command_considerations_does_not_touch_history(test_console):
    sentinel = object()
    history = [sentinel]
    shell.handle_command("/considerations", history)
    assert history == [sentinel]


def test_show_considerations_does_not_let_items_be_parsed_as_markup(test_console):
    """Consideration text traces back through the model, which may have
    ingested external content -- a stray '[' must render literally."""
    considerations.add_consideration("[bold red]not a style tag[/]")
    shell.handle_command("/considerations", [])
    output = test_console.export_text()
    assert "[bold red]not a style tag[/]" in output


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


def test_handle_command_price_dispatches_to_handle_tickers(test_console):
    with patch.object(shell, "handle_tickers") as mock_handle_tickers:
        shell.handle_command("/price AAPL TSLA", [])
    mock_handle_tickers.assert_called_once_with("AAPL TSLA")


def test_handle_command_price_without_a_ticker_shows_usage(test_console):
    with patch.object(shell, "handle_tickers") as mock_handle_tickers:
        shell.handle_command("/price", [])
    mock_handle_tickers.assert_not_called()
    assert "usage" in test_console.export_text()


def test_handle_command_price_is_llm_free(test_console):
    """/price must work with no LLM provider configured at all -- it's the
    one command that bypasses the agent entirely."""
    with patch("stoxlib.shell.fetch_quotes", return_value=([_quote()], [])):
        shell.handle_command("/price AAPL", [])
    assert "227.14" in test_console.export_text()


def test_handle_command_analyze_dispatches_to_handle_analyze(test_console):
    with patch.object(shell, "handle_analyze") as mock_handle_analyze:
        shell.handle_command("/analyze AAPL", [])
    mock_handle_analyze.assert_called_once_with("AAPL")


def test_handle_command_analyze_without_a_ticker_shows_usage(test_console):
    with patch.object(shell, "handle_analyze") as mock_handle_analyze:
        shell.handle_command("/analyze", [])
    mock_handle_analyze.assert_not_called()
    assert "usage" in test_console.export_text()


def test_handle_analyze_passes_the_analysis_callbacks(test_console):
    """run_stock_analysis's specialists run concurrently in threads, so
    handle_analyze must wire it to _print_analysis_tool_call (which takes
    a leading agent_name and locks the console) rather than plain
    _print_tool_call (used for the single-threaded ask_agent path)."""
    from stoxlib.analysis import AnalysisResult

    with patch("stoxlib.shell.run_stock_analysis",
               return_value=AnalysisResult(ticker="AAPL")) as mock_run:
        shell.handle_analyze("AAPL")

    assert mock_run.call_args.kwargs["on_agent_start"] is shell._print_agent_start
    assert mock_run.call_args.kwargs["on_tool_call"] is shell._print_analysis_tool_call


def test_print_analysis_tool_call_shows_agent_name_and_args(test_console):
    shell._print_analysis_tool_call("news", "get_stock_news", {"tickers": ["TSLA"]})
    output = test_console.export_text()
    assert "news" in output
    assert "get_stock_news" in output
    assert "TSLA" in output


def test_print_analysis_tool_call_does_not_let_args_be_parsed_as_markup(test_console):
    shell._print_analysis_tool_call("news", "read_article", {"url": "[bold red]not a style tag[/]"})
    output = test_console.export_text()
    assert "[bold red]not a style tag[/]" in output


def test_print_analysis_tool_call_is_safe_under_concurrent_calls(test_console):
    """Simulates the real usage from run_stock_analysis: several threads
    calling the same callback at once must not corrupt Console output --
    every line printed must come out intact and attributable."""
    import threading

    def _hammer(agent_name):
        for i in range(20):
            shell._print_analysis_tool_call(agent_name, "get_stock_quote", {"i": i})

    threads = [threading.Thread(target=_hammer, args=(name,))
               for name in ("trend", "fundamentals", "news")]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    lines = [line for line in test_console.export_text().splitlines() if line.strip()]
    assert len(lines) == 60
    for line in lines:
        assert "get_stock_quote" in line
        assert any(name in line for name in ("trend", "fundamentals", "news"))


def test_handle_query_shows_provider_and_answer(test_console, monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "deepseek")
    result = AgentResult(text="Apple is up today.", quotes=[_quote()])
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("what is apple trading at?", [])
    output = test_console.export_text()
    assert "deepseek" in output
    assert "Apple is up today." in output
    assert "227.14" in output


def test_handle_query_reports_error(test_console):
    result = AgentResult(error="no ANTHROPIC_API_KEY set -- see /help")
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("what is apple trading at?", [])
    assert "no ANTHROPIC_API_KEY set" in test_console.export_text()


def test_handle_query_passes_the_same_history_object_to_the_agent(test_console):
    """Regression: the agent had no memory of prior turns because nothing
    threaded conversation state through. handle_query must hand ask_agent
    the exact history list it was given, so ask_agent's in-place updates
    are visible to the caller on the next call."""
    history = []
    result = AgentResult(text="ok")
    with patch("stoxlib.agent.ask_agent", return_value=result) as mock_ask:
        shell.handle_query("what is apple trading at?", history)
    assert mock_ask.call_args.kwargs["history"] is history


def test_handle_query_passes_the_tool_call_callback_to_the_agent():
    result = AgentResult(text="ok")
    with patch("stoxlib.agent.ask_agent", return_value=result) as mock_ask:
        shell.handle_query("any news on apple?", [])
    assert mock_ask.call_args.kwargs["on_tool_call"] is shell._print_tool_call


def test_print_tool_call_shows_name_and_args(test_console):
    shell._print_tool_call("get_stock_news", {"tickers": ["TSLA"], "limit": 5})
    output = test_console.export_text()
    assert "get_stock_news" in output
    assert "TSLA" in output


def test_print_tool_call_does_not_let_args_be_parsed_as_markup(test_console):
    """Args trace back through the model, which may have ingested external
    content -- a stray '[' must render literally, not as a style tag."""
    shell._print_tool_call("read_article", {"url": "[bold red]not a style tag[/]"})
    output = test_console.export_text()
    assert "[bold red]not a style tag[/]" in output


def test_handle_query_shows_tool_calls_end_to_end(test_console):
    """Full path through ask_agent (not mocked) with a fake LLM, proving a
    tool call the model makes is actually visible to the user."""
    from langchain_core.messages import AIMessage

    class _FakeLLM:
        def __init__(self, responses):
            self._responses = list(responses)

        def bind_tools(self, tools):
            return self

        def invoke(self, messages):
            return self._responses.pop(0)

    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_news", "args": {"tickers": ["TSLA"], "limit": 3}, "id": "call1"},
        ]),
        AIMessage(content="Tesla has some news today.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.build_llm", return_value=llm), \
         patch("stoxlib.tools.fetch_news", return_value=[_article(title="Tesla news")]):
        shell.handle_query("any news on tesla?", [])

    output = test_console.export_text()
    assert "get_stock_news" in output
    assert "TSLA" in output
    assert "Tesla has some news today." in output


def _article(title="Apple hits new high"):
    return Article(title=title, date="2026-01-01T12:00:00+00:00",
                    link="https://example.com/a", symbols=["AAPL.US"],
                    sentiment={"polarity": 0.9}, summary="Some summary.")


def test_handle_query_shows_news(test_console):
    result = AgentResult(text="Here's the latest.", articles=[_article()])
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("any news on apple?", [])
    output = test_console.export_text()
    assert "Here's the latest." in output
    assert "Apple hits new high" in output
    assert "https://example.com/a" in output


def _geo_article(title="Taiwan tightens chip export rules"):
    from stoxlib.webz import GeoArticle
    return GeoArticle(title=title, date="2026-01-01T12:00:00+00:00",
                       link="https://example.com/g", country="TW",
                       sentiment="negative", summary="Some summary.")


def test_handle_query_shows_geo_news(test_console):
    result = AgentResult(text="Export controls could pressure chipmakers.",
                          geo_articles=[_geo_article()])
    with patch("stoxlib.agent.ask_agent", return_value=result):
        shell.handle_query("how do export controls affect chip stocks?", [])
    output = test_console.export_text()
    assert "Export controls could pressure chipmakers." in output
    assert "Taiwan tightens chip export rules" in output
    assert "https://example.com/g" in output


def test_main_routes_bare_ticker_input_to_the_agent(test_console, monkeypatch):
    """A bare ticker with no slash used to skip the agent entirely (the
    old, LLM-free "fast path"). Now it's just another line handed to the
    agent, which decides for itself that a bare ticker means "just the
    price" and answers accordingly (see AGENT_SYSTEM in agent.py) -- /price
    is the only way left to skip the agent."""
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    inputs = iter(["AAPL", "/quit"])
    monkeypatch.setattr(shell, "input", lambda *_args, **_kwargs: next(inputs), raising=False)

    with patch.object(shell, "handle_tickers") as mock_handle_tickers, \
         patch.object(shell, "handle_query") as mock_handle_query:
        shell.main()

    mock_handle_tickers.assert_not_called()
    mock_handle_query.assert_called_once_with("AAPL", [])


def test_main_routes_input_and_stops_on_quit(test_console, monkeypatch):
    """A light integration test: canned input lines should dispatch to the
    right handler, and /quit should end the loop cleanly. Every non-slash
    line -- including a bare ticker -- goes to the agent now; only /price
    (a slash command, handled by handle_command) skips it."""
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    inputs = iter(["AAPL", "what is apple trading at?", "any news on apple?", "/quit"])
    monkeypatch.setattr(shell, "input", lambda *_args, **_kwargs: next(inputs), raising=False)

    calls = []
    history_objects_seen = []

    def _fake_handle_query(text, history):
        calls.append(("query", text))
        history_objects_seen.append(history)

    monkeypatch.setattr(shell, "handle_query", _fake_handle_query)

    shell.main()

    assert calls == [
        ("query", "AAPL"),
        ("query", "what is apple trading at?"),
        ("query", "any news on apple?"),
    ]
    # the same history list must be reused across turns, or ask_agent's
    # in-place updates from the first query would never reach the second
    assert history_objects_seen[0] is history_objects_seen[1]


def test_main_routes_price_command_to_handle_tickers(test_console, monkeypatch):
    """/price is the one input that must skip the agent entirely."""
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    inputs = iter(["/price AAPL", "/quit"])
    monkeypatch.setattr(shell, "input", lambda *_args, **_kwargs: next(inputs), raising=False)

    with patch.object(shell, "handle_tickers") as mock_handle_tickers:
        shell.main()

    mock_handle_tickers.assert_called_once_with("AAPL")


def test_main_routes_a_non_english_question_to_the_agent(test_console, monkeypatch):
    """Regression: a Traditional Chinese question has no spaces and no
    English hint words, so it used to fall through to handle_tickers,
    which mangled the whole sentence into one bogus ticker and sent it to
    the quotes API (HTTP 422). It must route to the agent instead, same as
    any other natural-language question."""
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    inputs = iter(["請幫我分析Nvidia的股票", "/quit"])
    monkeypatch.setattr(shell, "input", lambda *_args, **_kwargs: next(inputs), raising=False)

    calls = []
    monkeypatch.setattr(shell, "handle_tickers", lambda text: calls.append(("tickers", text)))
    monkeypatch.setattr(shell, "handle_query", lambda text, history: calls.append(("query", text)))

    shell.main()

    assert calls == [("query", "請幫我分析Nvidia的股票")]


def test_main_stops_cleanly_on_eof(test_console, monkeypatch):
    monkeypatch.setattr(shell, "load_env", lambda: None)
    monkeypatch.setattr(shell, "_setup_readline", lambda: None)

    def _raise_eof(*_args, **_kwargs):
        raise EOFError

    monkeypatch.setattr(shell, "input", _raise_eof, raising=False)

    shell.main()  # should return, not raise
    assert "bye" in test_console.export_text()
