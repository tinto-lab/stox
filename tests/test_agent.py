from unittest.mock import Mock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from stoxlib import agent, considerations, monitors
from stoxlib.fundamentals import Fundamentals, FundamentalsError
from stoxlib.history import Bar, HistoryError
from stoxlib.news import Article, NewsError
from stoxlib.quotes import Quote, QuoteError
from stoxlib.webfetch import FetchError
from stoxlib.gnews import GeoArticle, GNewsError


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


def _article(title="Apple hits new high"):
    return Article(title=title, date="2026-01-01T12:00:00+00:00",
                    link="https://example.com/a", symbols=["AAPL.US"],
                    sentiment={"polarity": 0.9}, summary="Some summary.")


def _geo_article(title="Taiwan tightens chip export rules"):
    return GeoArticle(title=title, date="2026-01-01T12:00:00+00:00",
                       link="https://example.com/g", country="TW",
                       sentiment="negative", summary="Some summary.")


def _bar(code="AAPL.US", date="2026-01-01", close=227.14):
    return Bar(code=code, date=date, open_=225.0, high=228.0, low=224.5,
               close=close, volume=50_000_000)


def _fundamentals(code="AAPL.US"):
    return Fundamentals(code=code, name="Apple Inc.", sector="Technology",
                         industry="Consumer Electronics", market_cap=4.85e12,
                         pe_ratio=38.03, peg_ratio=2.66, profit_margin=0.2762,
                         operating_margin=0.3262, roe=1.4875, roa=0.2708,
                         ebitda=1.68e11, revenue_ttm=4.67e11,
                         revenue_growth_yoy=0.164, earnings_growth_yoy=0.287,
                         eps=8.74, dividend_yield=0.0032, analyst_target_price=327.20)


def test_run_quote_tool_formats_found_and_missing():
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], ["NOPE.US"])):
        text, quotes = agent.run_quote_tool(["AAPL", "NOPE"])

    assert "AAPL.US" in text
    assert "price=227.14" in text
    assert "NOPE.US: no data" in text
    assert quotes == [_quote()]


def test_run_quote_tool_surfaces_quote_error():
    with patch("stoxlib.tools.fetch_quotes", side_effect=QuoteError("access denied")):
        text, quotes = agent.run_quote_tool(["AAPL"])

    assert text == "error: access denied"
    assert quotes == []


def test_get_stock_quote_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])):
        result = agent.get_stock_quote.invoke({"tickers": ["AAPL"]})

    assert "AAPL.US" in result


def test_run_news_tool_formats_headlines():
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        text, articles = agent.run_news_tool(["AAPL"])

    assert "Apple hits new high" in text
    assert articles == [_article()]


def test_run_news_tool_output_includes_the_article_url():
    """Regression: read_article is useless if the model never sees a url
    to pass it -- the news tool's text must include each article's link."""
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        text, _ = agent.run_news_tool(["AAPL"])

    assert "https://example.com/a" in text


def test_run_news_tool_includes_each_article_s_full_text():
    """The point of fetching full text automatically: the model shouldn't
    have to spend a separate read_article call to see more than the
    provider's short summary."""
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body.") as mock_fetch:
        text, _ = agent.run_news_tool(["AAPL"])

    mock_fetch.assert_called_once_with("https://example.com/a")
    assert "Full article body." in text
    assert "Some summary." not in text


def test_run_news_tool_falls_back_to_the_short_summary_if_full_text_fails():
    """A paywalled or blocked article shouldn't drop out of the results --
    it should just fall back to the provider's own summary."""
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", side_effect=FetchError("blocked")):
        text, articles = agent.run_news_tool(["AAPL"])

    assert "Some summary." in text
    assert articles == [_article()]


def test_run_news_tool_reports_no_results():
    with patch("stoxlib.tools.fetch_news", return_value=[]):
        text, articles = agent.run_news_tool(["AAPL"])

    assert text == "no recent news found"
    assert articles == []


def test_run_news_tool_surfaces_news_error():
    with patch("stoxlib.tools.fetch_news", side_effect=NewsError("access denied")):
        text, articles = agent.run_news_tool(["AAPL"])

    assert text == "error: access denied"
    assert articles == []


def test_get_stock_news_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        result = agent.get_stock_news.invoke({"tickers": ["AAPL"]})

    assert "Apple hits new high" in result


def test_run_geo_news_tool_formats_headlines():
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        text, articles = agent.run_geo_news_tool("Taiwan chip export controls")

    assert "Taiwan tightens chip export rules" in text
    assert "https://example.com/g" in text
    assert articles == [_geo_article()]


def test_run_geo_news_tool_includes_each_article_s_full_text():
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body.") as mock_fetch:
        text, _ = agent.run_geo_news_tool("Taiwan chip export controls")

    mock_fetch.assert_called_once_with("https://example.com/g")
    assert "Full article body." in text
    assert "Some summary." not in text


def test_run_geo_news_tool_falls_back_to_the_short_summary_if_full_text_fails():
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", side_effect=FetchError("blocked")):
        text, articles = agent.run_geo_news_tool("Taiwan chip export controls")

    assert "Some summary." in text
    assert articles == [_geo_article()]


def test_run_geo_news_tool_reports_no_results():
    with patch("stoxlib.tools.fetch_geo_news", return_value=[]):
        text, articles = agent.run_geo_news_tool("some obscure query")

    assert text == "no relevant world news found"
    assert articles == []


def test_run_geo_news_tool_surfaces_fetch_error():
    with patch("stoxlib.tools.fetch_geo_news", side_effect=GNewsError("server returned HTTP 503")):
        text, articles = agent.run_geo_news_tool("query")

    assert text == "error: server returned HTTP 503"
    assert articles == []


def test_get_geopolitical_news_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        result = agent.get_geopolitical_news.invoke({"query": "Taiwan chip export controls"})

    assert "Taiwan tightens chip export rules" in result


def test_run_history_tool_summarizes_bars():
    bars = [_bar(date="2026-01-01", close=220.0), _bar(date="2026-01-31", close=227.14)]
    with patch("stoxlib.tools.fetch_history", return_value=bars):
        text, result_bars = agent.run_history_tool("AAPL", days=30)

    assert "AAPL.US" in text
    assert "start=220.00" in text
    assert "end=227.14" in text
    assert "change=+7.14" in text
    assert result_bars == bars


def test_run_history_tool_surfaces_history_error():
    with patch("stoxlib.tools.fetch_history", side_effect=HistoryError("access denied")):
        text, bars = agent.run_history_tool("AAPL")

    assert text == "error: access denied"
    assert bars == []


def test_run_history_tool_reports_no_results():
    with patch("stoxlib.tools.fetch_history", return_value=[]):
        text, bars = agent.run_history_tool("AAPL")

    assert text == "no historical data found"
    assert bars == []


def test_get_price_history_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_history", return_value=[_bar()]):
        result = agent.get_price_history.invoke({"ticker": "AAPL"})

    assert "AAPL.US" in result


def test_run_fundamentals_tool_formats_metrics():
    with patch("stoxlib.tools.fetch_fundamentals", return_value=_fundamentals()):
        text, f = agent.run_fundamentals_tool("AAPL")

    assert "AAPL.US" in text
    assert "Apple Inc." in text
    assert "profit_margin=27.62%" in text
    assert f == _fundamentals()


def test_run_fundamentals_tool_handles_missing_optional_fields():
    partial = _fundamentals()
    partial.pe_ratio = None
    partial.dividend_yield = None
    with patch("stoxlib.tools.fetch_fundamentals", return_value=partial):
        text, _ = agent.run_fundamentals_tool("AAPL")

    assert "pe_ratio=NA" in text
    assert "dividend_yield=NA" in text


def test_run_fundamentals_tool_surfaces_fundamentals_error():
    with patch("stoxlib.tools.fetch_fundamentals", side_effect=FundamentalsError("access denied")):
        text, f = agent.run_fundamentals_tool("AAPL")

    assert text == "error: access denied"
    assert f is None


def test_get_company_fundamentals_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_fundamentals", return_value=_fundamentals()):
        result = agent.get_company_fundamentals.invoke({"ticker": "AAPL"})

    assert "AAPL.US" in result


def test_run_read_article_tool_returns_extracted_text():
    with patch("stoxlib.tools.fetch_article_text", return_value="full article text"):
        result = agent.run_read_article_tool("https://example.com/a")

    assert result == "full article text"


def test_run_read_article_tool_surfaces_fetch_error():
    with patch("stoxlib.tools.fetch_article_text", side_effect=FetchError("HTTP 404")):
        result = agent.run_read_article_tool("https://example.com/a")

    assert result == "error: HTTP 404"


def test_read_article_tool_returns_text_only():
    with patch("stoxlib.tools.fetch_article_text", return_value="full article text"):
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
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])):
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
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])), \
         patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
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
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        result = agent.ask_agent("any news on apple?", llm=llm)

    assert result.error is None
    assert result.text == "Apple's in the news today."
    assert result.articles == [_article()]
    assert result.quotes == []


def test_ask_agent_executes_geo_news_tool_then_answers():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_geopolitical_news",
             "args": {"query": "Taiwan chip export controls"}, "id": "call1"},
        ]),
        AIMessage(content="Export controls could pressure chipmakers.", tool_calls=[]),
    ])
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
        result = agent.ask_agent("how do export controls affect chip stocks?", llm=llm)

    assert result.error is None
    assert result.text == "Export controls could pressure chipmakers."
    assert result.geo_articles == [_geo_article()]
    assert result.quotes == []


def test_ask_agent_executes_history_tool_then_answers():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_price_history", "args": {"ticker": "AAPL", "days": 30}, "id": "call1"},
        ]),
        AIMessage(content="Apple is up over the past month.", tool_calls=[]),
    ])
    bars = [_bar(date="2026-01-01", close=220.0), _bar(date="2026-01-31", close=227.14)]
    with patch("stoxlib.tools.fetch_history", return_value=bars):
        result = agent.ask_agent("how has apple done over the past month?", llm=llm)

    assert result.error is None
    assert result.text == "Apple is up over the past month."
    assert result.bars == bars
    assert result.quotes == []


def test_ask_agent_executes_fundamentals_tool_then_answers():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_company_fundamentals", "args": {"ticker": "AAPL"}, "id": "call1"},
        ]),
        AIMessage(content="Apple's margins look healthy.", tool_calls=[]),
    ])
    with patch("stoxlib.tools.fetch_fundamentals", return_value=_fundamentals()):
        result = agent.ask_agent("how profitable is apple?", llm=llm)

    assert result.error is None
    assert result.text == "Apple's margins look healthy."
    assert result.fundamentals == _fundamentals()


def test_ask_agent_executes_analyze_stock_tool_then_answers():
    """analyze_stock is dispatched straight to run_analyze_stock_tool (not
    through the @tool-wrapped analyze_stock.invoke), the same way every
    other tool call in this loop bypasses its own @tool wrapper -- so
    patching stoxlib.analysis.run_analyze_stock_tool is what actually
    intercepts it."""
    from stoxlib.analysis import AnalysisResult

    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "analyze_stock", "args": {"ticker": "AAPL"}, "id": "call1"},
        ]),
        AIMessage(content="Here's the risk picture on Apple.", tool_calls=[]),
    ])
    fake_result = AnalysisResult(
        ticker="AAPL", trend_text="up", fundamentals_text="solid",
        news_text="quiet", geopolitics_text="limited exposure",
        verdict_text="low risk, favorable",
        quotes=[_quote()], bars=[_bar()], articles=[_article()],
        geo_articles=[_geo_article()], fundamentals=_fundamentals(),
    )
    with patch("stoxlib.analysis.run_analyze_stock_tool", return_value=("...", fake_result)):
        result = agent.ask_agent("should I buy apple?", llm=llm)

    assert result.error is None
    assert result.text == "Here's the risk picture on Apple."
    assert result.analysis is fake_result
    assert result.quotes == [_quote()]
    assert result.bars == [_bar()]
    assert result.articles == [_article()]
    assert result.geo_articles == [_geo_article()]
    assert result.fundamentals == _fundamentals()


def test_ask_agent_passes_analysis_callbacks_to_analyze_stock():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "analyze_stock", "args": {"ticker": "AAPL"}, "id": "call1"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    on_start, on_call = Mock(), Mock()
    with patch("stoxlib.analysis.run_analyze_stock_tool", return_value=("...", None)) as mock_tool:
        agent.ask_agent("should I buy apple?", llm=llm, on_analysis_agent_start=on_start,
                        on_analysis_tool_call=on_call)

    assert mock_tool.call_args.kwargs["on_agent_start"] is on_start
    assert mock_tool.call_args.kwargs["on_tool_call"] is on_call


def test_ask_agent_can_call_both_tools_in_one_turn():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call1"},
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"]}, "id": "call2"},
        ]),
        AIMessage(content="Apple is up, and here's what's going on.", tool_calls=[]),
    ])
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])), \
         patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="Full article body."):
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
    with patch("stoxlib.tools.fetch_news", return_value=[_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="full article text") as mock_fetch:
        result = agent.ask_agent("what does the apple article say in detail?", llm=llm)

    # get_stock_news already fetches full text for every article automatically,
    # so read_article's explicit call is a second fetch of the same url, not
    # the only one -- assert_any_call rather than assert_called_once_with.
    mock_fetch.assert_any_call("https://example.com/a")
    assert result.error is None
    assert result.text == "Here's the detail from the full article."


def test_ask_agent_reads_article_after_getting_its_url_from_geo_news():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_geopolitical_news", "args": {"query": "Taiwan tariffs"}, "id": "call1"},
        ]),
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://example.com/g"}, "id": "call2"},
        ]),
        AIMessage(content="Here's the detail from the full article.", tool_calls=[]),
    ])
    with patch("stoxlib.tools.fetch_geo_news", return_value=[_geo_article()]), \
         patch("stoxlib.tools.fetch_article_text", return_value="full article text") as mock_fetch:
        result = agent.ask_agent("what does that article say in detail?", llm=llm)

    # same reasoning as the news version above: get_geopolitical_news
    # already fetched this url once automatically.
    mock_fetch.assert_any_call("https://example.com/g")
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
    with patch("stoxlib.tools.fetch_article_text") as mock_fetch:
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


def test_ask_agent_creates_lists_and_deletes_news_monitors():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "create_news_monitor",
             "args": {"goal": "alert me when oil rises", "queries": ["Iran", "OPEC output"],
                      "tickers": ["uso"]}, "id": "call1"},
        ]),
        AIMessage(content="Watching Iran and OPEC news for you.", tool_calls=[]),
    ])
    result = agent.ask_agent("alert me when oil rises", llm=llm)

    assert result.error is None
    (m,) = monitors.load_monitors()
    assert (m["goal"], m["queries"], m["tickers"]) == (
        "alert me when oil rises", ["Iran", "OPEC output"], ["USO"])
    assert "created monitor %s" % m["id"] in llm.received_messages[1][-1].content

    assert m["id"] in agent.run_list_monitors_tool()
    assert agent.run_delete_monitor_tool("nope").startswith("error:")
    assert agent.run_delete_monitor_tool(m["id"]) == "deleted monitor %s" % m["id"]
    assert agent.run_list_monitors_tool() == "no news monitors"


def test_create_news_monitor_rejects_no_queries():
    assert agent.run_create_monitor_tool("oil", [], []).startswith("error:")
    assert monitors.load_monitors() == []


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
    with patch("stoxlib.tools.fetch_quotes", return_value=([_quote()], [])):
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
    with patch("stoxlib.tools.fetch_article_text", return_value="full text") as mock_fetch:
        result = agent.ask_agent("tell me more about that", history=history, llm=llm)

    mock_fetch.assert_called_once_with("https://example.com/a")
    assert result.error is None
    assert result.text == "Here's more detail."


def test_record_analysis_appends_a_tool_call_turn_the_agent_can_build_on():
    """A recorded /analyze run must be a well-formed tool-call turn (so the
    provider accepts it) and must expose its source urls to read_article
    on a later ask_agent turn."""
    from stoxlib.analysis import AnalysisResult

    history = []
    agent.record_analysis(history, "AAPL.US", AnalysisResult(
        ticker="AAPL.US", verdict_text="high risk", articles=[_article()]))

    human, call, tool_msg, answer = history
    assert isinstance(human, HumanMessage)
    assert call.tool_calls[0]["name"] == "analyze_stock"
    assert tool_msg.tool_call_id == call.tool_calls[0]["id"]
    assert "high risk" in tool_msg.content
    assert isinstance(answer, AIMessage) and not answer.tool_calls
    assert agent._article_urls_in(history) == {"https://example.com/a"}


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
