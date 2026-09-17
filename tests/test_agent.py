from unittest.mock import Mock, patch

from langchain_core.messages import AIMessage

from stoxlib import agent
from stoxlib.quotes import Quote, QuoteError


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


def test_run_quote_tool_formats_found_and_missing():
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], ["NOPE.US"])):
        text, quotes = agent.run_quote_tool(["AAPL", "NOPE"])

    assert "AAPL.US" in text
    assert "price=227.14" in text
    assert "NOPE.US: no data" in text
    assert quotes == [_quote()]


def test_run_quote_tool_surfaces_quote_error():
    with patch("stoxlib.agent.fetch_quotes", side_effect=QuoteError("access denied")):
        text, quotes = agent.run_quote_tool(["AAPL"])

    assert text == "error: access denied"
    assert quotes == []


def test_get_stock_quote_tool_returns_text_only():
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], [])):
        result = agent.get_stock_quote.invoke({"tickers": ["AAPL"]})

    assert "AAPL.US" in result


class _FakeLLM:
    """Stand-in for a LangChain chat model bound with tools."""

    def __init__(self, responses):
        self._responses = list(responses)

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        return self._responses.pop(0)


def test_ask_agent_returns_direct_answer_without_tool_calls():
    llm = _FakeLLM([AIMessage(content="Apple is around $227.", tool_calls=[])])
    result = agent.ask_agent("what is apple trading at?", llm=llm)

    assert result.error is None
    assert result.text == "Apple is around $227."
    assert result.quotes == []


def test_ask_agent_executes_tool_call_then_answers():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="Apple is trading up today.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], [])):
        result = agent.ask_agent("what is apple trading at?", llm=llm)

    assert result.error is None
    assert result.text == "Apple is trading up today."
    assert result.quotes == [_quote()]


def test_ask_agent_reports_unknown_tool_without_crashing():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "some_other_tool", "args": {}, "id": "call1"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    result = agent.ask_agent("do something else", llm=llm)

    assert result.error is None
    assert result.text == "done"


def test_ask_agent_builds_llm_when_none_given_and_reports_agent_error():
    # No provider configured (env cleared by the autouse fixture) -> build_llm()
    # raises AgentError, which ask_agent must turn into a result, not a crash.
    result = agent.ask_agent("what is apple trading at?")
    assert result.error is not None
    assert "ANTHROPIC_API_KEY" in result.error


def test_ask_agent_wraps_unexpected_exceptions():
    llm = Mock()
    llm.bind_tools.return_value = llm
    llm.invoke.side_effect = RuntimeError("provider blew up")

    result = agent.ask_agent("what is apple trading at?", llm=llm)

    assert result.error == "agent error: provider blew up"
