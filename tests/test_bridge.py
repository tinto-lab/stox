import io
import json
import sys
from unittest.mock import Mock, patch

from langchain_core.messages import AIMessage

from stoxlib import bridge, considerations
from stoxlib.quotes import Quote, QuoteError


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


class _FakeLLM:
    """Stand-in for a LangChain chat model bound with tools -- same shape
    as test_agent.py's, since ask_agent's tool loop drives it the same way
    regardless of who's calling ask_agent."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.received_messages = []

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self.received_messages.append(list(messages))
        return self._responses.pop(0)


def _run(lines, monkeypatch):
    """Feed `lines` (already-JSON-encoded strings) to bridge.main() as
    stdin and return the parsed JSON events it wrote to stdout, in order.
    Patches config.load_env to a no-op so a developer's real .env can't
    leak into the test (mirrors test_shell.py's handling of shell.load_env),
    on top of conftest's autouse env-stripping."""
    monkeypatch.setattr(bridge.config, "load_env", lambda: None)
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(lines) + "\n"))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    bridge.main()
    return [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]


def _cmd(**fields):
    return json.dumps(fields)


def test_quote_command_returns_quotes_and_missing(monkeypatch):
    with patch("stoxlib.quotes.fetch_quotes", return_value=([_quote()], ["NOPE.US"])):
        events = _run([_cmd(id="1", cmd="quote", tickers=["AAPL", "NOPE"])], monkeypatch)

    assert len(events) == 1
    assert events[0] == {
        "id": "1", "type": "result",
        "data": {"quotes": [dict(_quote().__dict__)], "missing": ["NOPE.US"]},
    }


def test_quote_command_surfaces_quote_error(monkeypatch):
    with patch("stoxlib.quotes.fetch_quotes", side_effect=QuoteError("access denied")):
        events = _run([_cmd(id="1", cmd="quote", tickers=["AAPL"])], monkeypatch)

    assert events == [{"id": "1", "type": "error", "message": "access denied"}]


def test_ask_command_returns_direct_answer(monkeypatch):
    llm = _FakeLLM([AIMessage(content="Apple is around $227.", tool_calls=[])])
    with patch("stoxlib.agent.build_llm", return_value=llm):
        events = _run([_cmd(id="1", cmd="ask", text="what is apple trading at?")], monkeypatch)

    assert len(events) == 1
    assert events[0]["type"] == "result"
    assert events[0]["data"]["text"] == "Apple is around $227."


def test_ask_command_emits_tool_call_before_result(monkeypatch):
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="Apple is trading up today.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.build_llm", return_value=llm), \
         patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])):
        events = _run([_cmd(id="1", cmd="ask", text="what is apple trading at?")], monkeypatch)

    assert len(events) == 2
    assert events[0] == {"id": "1", "type": "tool_call", "name": "get_stock_quote",
                          "args": {"tickers": ["AAPL"]}}
    assert events[1]["type"] == "result"
    assert events[1]["data"]["text"] == "Apple is trading up today."


def test_ask_command_emits_error_when_no_provider_key_configured(monkeypatch):
    events = _run([_cmd(id="1", cmd="ask", text="what is apple trading at?")], monkeypatch)

    assert len(events) == 1
    assert events[0]["id"] == "1"
    assert events[0]["type"] == "error"
    assert "ANTHROPIC_API_KEY" in events[0]["message"]


def test_reset_command_clears_conversation_history(monkeypatch):
    llm = _FakeLLM([
        AIMessage(content="answer one", tool_calls=[]),
        AIMessage(content="answer two", tool_calls=[]),
        AIMessage(content="answer three", tool_calls=[]),
    ])
    with patch("stoxlib.agent.build_llm", return_value=llm):
        events = _run([
            _cmd(id="1", cmd="ask", text="q1"),
            _cmd(id="2", cmd="ask", text="q2"),
            _cmd(id="3", cmd="reset"),
            _cmd(id="4", cmd="ask", text="q3"),
        ], monkeypatch)

    assert [e["id"] for e in events] == ["1", "2", "3", "4"]
    # call 2 sees call 1's turn in history (system + q1 + answer-one + q2 = 4 messages)
    assert len(llm.received_messages[1]) == 4
    # after reset, call 4 starts from empty history again (system + q3 = 2 messages)
    assert len(llm.received_messages[2]) == 2


def test_considerations_add_list_remove_roundtrip(monkeypatch):
    events = _run([
        _cmd(id="1", cmd="considerations_add", text="always mention insider selling"),
        _cmd(id="2", cmd="considerations_list"),
        _cmd(id="3", cmd="considerations_remove", text="always mention insider selling"),
        _cmd(id="4", cmd="considerations_list"),
    ], monkeypatch)

    assert events[0]["data"]["considerations"] == ["always mention insider selling"]
    assert events[1]["data"]["considerations"] == ["always mention insider selling"]
    assert events[2]["data"]["considerations"] == []
    assert events[3]["data"]["considerations"] == []
    assert considerations.load_considerations() == []


def test_status_reports_key_presence(monkeypatch):
    monkeypatch.setenv("EODHD_API_KEY", "demo")
    monkeypatch.setenv("STOX_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")

    events = _run([_cmd(id="1", cmd="status")], monkeypatch)

    assert events == [{"id": "1", "type": "result", "data": {
        "eodhd_key": True, "provider": "deepseek",
        "model": "deepseek/deepseek-chat", "provider_key_present": True,
    }}]


def test_unknown_command_emits_error(monkeypatch):
    events = _run([_cmd(id="1", cmd="not-a-real-command")], monkeypatch)
    assert events == [{"id": "1", "type": "error", "message": "unknown command: not-a-real-command"}]


def test_invalid_json_line_emits_error_with_null_id(monkeypatch):
    events = _run(["not json at all"], monkeypatch)
    assert events == [{"id": None, "type": "error", "message": "invalid JSON"}]


def test_analyze_command_emits_specialist_events_and_records_history(monkeypatch):
    seen = []

    def _fake_trend(llm, ticker, on_tool_call=None):
        if on_tool_call:
            on_tool_call("get_price_history", {"ticker": ticker})
        return "trend text", [_quote()], []

    def _fake_fundamentals(llm, ticker, on_tool_call=None):
        return "fundamentals text", None

    def _fake_news(llm, ticker, on_tool_call=None):
        return "news text", []

    def _fake_geopolitics(llm, ticker, on_tool_call=None):
        return "geo text", []

    followup_llm = _FakeLLM([AIMessage(content="follow-up answer", tool_calls=[])])

    with patch("stoxlib.analysis.build_llm", return_value=Mock()), \
         patch("stoxlib.analysis._run_trend_agent", side_effect=_fake_trend), \
         patch("stoxlib.analysis._run_fundamentals_agent", side_effect=_fake_fundamentals), \
         patch("stoxlib.analysis._run_news_agent", side_effect=_fake_news), \
         patch("stoxlib.analysis._run_geopolitics_agent", side_effect=_fake_geopolitics), \
         patch("stoxlib.analysis._run_aggregator", return_value="verdict text"), \
         patch("stoxlib.agent.build_llm", return_value=followup_llm):
        events = _run([
            _cmd(id="1", cmd="analyze", ticker="AAPL"),
            _cmd(id="2", cmd="ask", text="why is the risk high?"),
        ], monkeypatch)

    specialist_starts = [e["name"] for e in events if e.get("type") == "specialist_start"]
    assert specialist_starts == ["trend", "fundamentals", "news", "geopolitics", "aggregator"]

    tool_call_events = [e for e in events if e.get("type") == "specialist_tool_call"]
    assert tool_call_events == [{"id": "1", "type": "specialist_tool_call", "agent": "trend",
                                  "name": "get_price_history", "args": {"ticker": "AAPL"}}]

    [result_event] = [e for e in events if e["id"] == "1" and e["type"] == "result"]
    assert result_event["data"]["verdict_text"] == "verdict text"
    assert result_event["data"]["trend_text"] == "trend text"

    # the /analyze run was recorded into session history, so the follow-up
    # ask sees it (system + /analyze turn's 4 messages + this question = 6)
    assert len(followup_llm.received_messages[0]) == 6


def test_analyze_command_surfaces_error(monkeypatch):
    events = _run([_cmd(id="1", cmd="analyze", ticker="AAPL")], monkeypatch)
    assert len(events) == 1
    assert events[0]["id"] == "1"
    assert events[0]["type"] == "error"
