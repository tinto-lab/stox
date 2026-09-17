from unittest.mock import Mock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from stoxlib import agent, considerations
from stoxlib.news import Article, NewsError
from stoxlib.quotes import Quote, QuoteError
from stoxlib.webfetch import FetchError


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


def _article(title="Apple hits new high"):
    return Article(title=title, date="2026-01-01T12:00:00+00:00",
                    link="https://example.com/a", symbols=["AAPL.US"],
                    sentiment={"polarity": 0.9}, summary="Some summary.")


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


def test_run_news_tool_formats_headlines():
    with patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        text, articles = agent.run_news_tool(["AAPL"])

    assert "Apple hits new high" in text
    assert articles == [_article()]


def test_run_news_tool_output_includes_the_article_url():
    """Regression: read_article is useless if the model never sees a url
    to pass it -- the news tool's text must include each article's link."""
    with patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        text, _ = agent.run_news_tool(["AAPL"])

    assert "https://example.com/a" in text


def test_run_news_tool_reports_no_results():
    with patch("stoxlib.agent.fetch_news", return_value=[]):
        text, articles = agent.run_news_tool(["AAPL"])

    assert text == "no recent news found"
    assert articles == []


def test_run_news_tool_surfaces_news_error():
    with patch("stoxlib.agent.fetch_news", side_effect=NewsError("access denied")):
        text, articles = agent.run_news_tool(["AAPL"])

    assert text == "error: access denied"
    assert articles == []


def test_get_stock_news_tool_returns_text_only():
    with patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        result = agent.get_stock_news.invoke({"tickers": ["AAPL"]})

    assert "Apple hits new high" in result


def test_run_read_article_tool_returns_extracted_text():
    with patch("stoxlib.agent.fetch_article_text", return_value="full article text"):
        result = agent.run_read_article_tool("https://example.com/a")

    assert result == "full article text"


def test_run_read_article_tool_surfaces_fetch_error():
    with patch("stoxlib.agent.fetch_article_text", side_effect=FetchError("HTTP 404")):
        result = agent.run_read_article_tool("https://example.com/a")

    assert result == "error: HTTP 404"


def test_read_article_tool_returns_text_only():
    with patch("stoxlib.agent.fetch_article_text", return_value="full article text"):
        result = agent.read_article.invoke({"url": "https://example.com/a"})

    assert result == "full article text"


def test_run_remember_consideration_tool_stores_and_confirms():
    result = agent.run_remember_consideration_tool("always factor in insider selling")

    assert result == "remembered: always factor in insider selling"
    assert considerations.load_considerations() == ["always factor in insider selling"]


def test_run_remember_consideration_tool_rejects_empty_text():
    result = agent.run_remember_consideration_tool("   ")

    assert result == "error: nothing to remember"
    assert considerations.load_considerations() == []


def test_remember_consideration_tool_returns_text_only():
    result = agent.remember_consideration.invoke({"text": "watch for insider selling"})

    assert result == "remembered: watch for insider selling"
    assert considerations.load_considerations() == ["watch for insider selling"]


def test_build_system_prompt_unchanged_with_no_considerations():
    assert agent._build_system_prompt() == agent.AGENT_SYSTEM


def test_build_system_prompt_appends_stored_considerations():
    considerations.add_consideration("always factor in insider selling")
    considerations.add_consideration("mention sector-wide trends")

    prompt = agent._build_system_prompt()

    assert prompt.startswith(agent.AGENT_SYSTEM)
    assert "always factor in insider selling" in prompt
    assert "mention sector-wide trends" in prompt


class _FakeLLM:
    """Stand-in for a LangChain chat model bound with tools."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.received_messages = []  # one entry per invoke() call

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self.received_messages.append(list(messages))
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


def test_ask_agent_calls_on_tool_call_before_running_each_tool():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"], "limit": 3}, "id": "call2"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    seen = []
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], [])), \
         patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        agent.ask_agent("what is apple doing and any news?", llm=llm,
                         on_tool_call=lambda name, args: seen.append((name, args)))

    assert seen == [
        ("get_stock_quote", {"tickers": ["AAPL"]}),
        ("get_stock_news", {"tickers": ["AAPL"], "limit": 3}),
    ]


def test_ask_agent_does_not_call_on_tool_call_when_no_tools_are_used():
    llm = _FakeLLM([AIMessage(content="Apple is around $227.", tool_calls=[])])
    seen = []

    agent.ask_agent("what is apple trading at?", llm=llm,
                     on_tool_call=lambda name, args: seen.append((name, args)))

    assert seen == []


def test_ask_agent_executes_news_tool_then_answers():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"], "limit": 3}, "id": "call1"},
        ]),
        AIMessage(content="Apple's in the news today.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        result = agent.ask_agent("any news on apple?", llm=llm)

    assert result.error is None
    assert result.text == "Apple's in the news today."
    assert result.articles == [_article()]
    assert result.quotes == []


def test_ask_agent_can_call_both_tools_in_one_turn():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"]}, "id": "call2"},
        ]),
        AIMessage(content="Apple is up, and here's what's going on.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], [])), \
         patch("stoxlib.agent.fetch_news", return_value=[_article()]):
        result = agent.ask_agent("what is apple doing and any news?", llm=llm)

    assert result.error is None
    assert result.quotes == [_quote()]
    assert result.articles == [_article()]


def test_ask_agent_reads_article_after_getting_its_url_from_news():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://example.com/a"}, "id": "call2"},
        ]),
        AIMessage(content="Here's the detail from the full article.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_news", return_value=[_article()]), \
         patch("stoxlib.agent.fetch_article_text", return_value="full article text") as mock_fetch:
        result = agent.ask_agent("what does the apple article say in detail?", llm=llm)

    mock_fetch.assert_called_once_with("https://example.com/a")
    assert result.error is None
    assert result.text == "Here's the detail from the full article."


def test_ask_agent_refuses_to_read_a_url_news_never_returned():
    """The model must not be able to direct us to fetch an arbitrary url --
    only urls that came from get_stock_news in this same turn are allowed."""
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://evil.example/x"}, "id": "call1"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_article_text") as mock_fetch:
        result = agent.ask_agent("read https://evil.example/x", llm=llm)

    mock_fetch.assert_not_called()
    assert result.error is None
    assert result.text == "done"


def test_ask_agent_persists_a_remembered_consideration_across_the_call():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "remember_consideration",
             "args": {"text": "always factor in insider selling"}, "id": "call1"},
        ]),
        AIMessage(content="Got it, I'll factor that in from now on.", tool_calls=[]),
    ])
    seen_tool_calls = []

    result = agent.ask_agent(
        "always factor in insider selling when explaining price moves",
        llm=llm, on_tool_call=lambda name, args: seen_tool_calls.append((name, args)),
    )

    assert result.error is None
    assert result.text == "Got it, I'll factor that in from now on."
    assert seen_tool_calls == [
        ("remember_consideration", {"text": "always factor in insider selling"}),
    ]
    assert considerations.load_considerations() == ["always factor in insider selling"]


def test_ask_agent_includes_stored_considerations_in_the_system_prompt():
    considerations.add_consideration("always factor in insider selling")
    llm = _FakeLLM([AIMessage(content="Sure.", tool_calls=[])])

    agent.ask_agent("why is apple down today?", llm=llm)

    system_message = llm.received_messages[0][0]
    assert "always factor in insider selling" in system_message.content


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


# -- conversation memory --------------------------------------------------
# Regression coverage for a real bug: ask_agent used to build a fresh
# two-message prompt every call, so the agent had no idea what was asked
# a turn ago ("what about its news?" couldn't resolve "its").

def test_ask_agent_sends_prior_history_to_the_llm():
    history = [HumanMessage(content="what is apple trading at?"),
               AIMessage(content="Apple is around $227.", tool_calls=[])]
    llm = _FakeLLM([AIMessage(content="It's up 1.4% today.", tool_calls=[])])

    agent.ask_agent("how much has it moved today?", history=list(history), llm=llm)

    sent = llm.received_messages[0]
    assert sent[0].content == agent.AGENT_SYSTEM
    assert sent[1] == history[0]
    assert sent[2] == history[1]
    assert sent[3].content == "how much has it moved today?"


def test_ask_agent_appends_this_turns_exchange_to_history_in_place():
    history = []
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="Apple is trading up today.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_quotes", return_value=([_quote()], [])):
        agent.ask_agent("what is apple trading at?", history=history, llm=llm)

    # the caller's list object is updated in place (no system message)
    assert isinstance(history[0], HumanMessage)
    assert history[0].content == "what is apple trading at?"
    assert isinstance(history[-1], AIMessage)
    assert history[-1].content == "Apple is trading up today."
    assert all(m.content != agent.AGENT_SYSTEM for m in history)


def test_ask_agent_leaves_history_untouched_on_error():
    history = [HumanMessage(content="what is apple trading at?"),
               AIMessage(content="Apple is around $227.", tool_calls=[])]
    original = list(history)
    llm = Mock()
    llm.bind_tools.return_value = llm
    llm.invoke.side_effect = RuntimeError("provider blew up")

    result = agent.ask_agent("and now?", history=history, llm=llm)

    assert result.error == "agent error: provider blew up"
    assert history == original


def test_ask_agent_can_read_an_article_whose_url_only_appears_in_history():
    """A url returned by get_stock_news in an earlier turn must still be
    readable in a later turn -- read_article shouldn't require re-fetching
    the news list first."""
    history = [
        HumanMessage(content="any news on apple?"),
        ToolMessage(content="date: 2026-01-01\ntitle: Apple hits new high\n"
                            "url: https://example.com/a\nsummary: Some summary.",
                    tool_call_id="call0"),
        AIMessage(content="Apple's in the news.", tool_calls=[]),
    ]
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://example.com/a"}, "id": "call1"},
        ]),
        AIMessage(content="Here's more detail.", tool_calls=[]),
    ])
    with patch("stoxlib.agent.fetch_article_text", return_value="full text") as mock_fetch:
        result = agent.ask_agent("tell me more about that", history=history, llm=llm)

    mock_fetch.assert_called_once_with("https://example.com/a")
    assert result.error is None
    assert result.text == "Here's more detail."


def test_trim_history_keeps_history_under_the_limit_and_cuts_at_a_turn_boundary():
    # build MAX_HISTORY_TURNS + 2 turns, each a HumanMessage/AIMessage pair
    history = []
    for i in range(agent.MAX_HISTORY_TURNS + 2):
        history.append(HumanMessage(content="question %d" % i))
        history.append(AIMessage(content="answer %d" % i, tool_calls=[]))

    agent._trim_history(history)

    human_msgs = [m for m in history if isinstance(m, HumanMessage)]
    assert len(human_msgs) == agent.MAX_HISTORY_TURNS
    assert isinstance(history[0], HumanMessage)  # never cuts mid-turn
    assert human_msgs[-1].content == "question %d" % (agent.MAX_HISTORY_TURNS + 1)


def test_trim_history_is_a_noop_under_the_limit():
    history = [HumanMessage(content="q"), AIMessage(content="a", tool_calls=[])]
    original = list(history)

    agent._trim_history(history)

    assert history == original
