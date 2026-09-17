from unittest.mock import Mock, patch

import pytest
from langchain_core.messages import AIMessage

from stoxlib import analysis, considerations
from stoxlib.fundamentals import Fundamentals
from stoxlib.history import Bar
from stoxlib.news import Article
from stoxlib.quotes import Quote
from stoxlib.webz import GeoArticle


def _quote(code="AAPL.US"):
    return Quote(code=code, price=227.14, change=3.04, percent=1.36,
                 open_=225.0, high=228.0, low=224.5, prev_close=224.10,
                 volume=50_000_000)


def _article(title="Apple hits new high"):
    return Article(title=title, date="2026-01-01T12:00:00+00:00",
                    link="https://example.com/a", symbols=["AAPL.US"],
                    sentiment={"polarity": 0.9}, summary="Some summary.")


def _bar(code="AAPL.US", date="2026-01-01", close=227.14):
    return Bar(code=code, date=date, open_=225.0, high=228.0, low=224.5,
               close=close, volume=50_000_000)


def _geo_article(title="Taiwan tightens chip export rules"):
    return GeoArticle(title=title, date="2026-01-01T12:00:00+00:00",
                       link="https://example.com/g", country="TW",
                       sentiment="negative", summary="Some summary.")


def _fundamentals(code="AAPL.US"):
    return Fundamentals(code=code, name="Apple Inc.", sector="Technology",
                         industry="Consumer Electronics", market_cap=4.85e12,
                         pe_ratio=38.03, peg_ratio=2.66, profit_margin=0.2762,
                         operating_margin=0.3262, roe=1.4875, roa=0.2708,
                         ebitda=1.68e11, revenue_ttm=4.67e11,
                         revenue_growth_yoy=0.164, earnings_growth_yoy=0.287,
                         eps=8.74, dividend_yield=0.0032, analyst_target_price=327.20)


class _FakeLLM:
    """Stand-in for a LangChain chat model. bind_tools() returns self, and
    each invoke() pops the next queued response -- same shape as
    test_agent.py's fake, reused here for the specialist tool-call loops."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.received_messages = []

    def bind_tools(self, tools):
        return self

    def invoke(self, messages):
        self.received_messages.append(list(messages))
        return self._responses.pop(0)


# -- specialist agents -----------------------------------------------------

def test_run_trend_agent_calls_tools_and_returns_text():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_price_history", "args": {"ticker": "AAPL", "days": 90}, "id": "call1"},
            {"name": "get_stock_quote", "args": {"tickers": ["AAPL"]}, "id": "call2"},
        ]),
        AIMessage(content="Apple is trending up with low volatility.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_history_tool", return_value=("hist", [_bar()])), \
         patch("stoxlib.analysis.run_quote_tool", return_value=("quote", [_quote()])):
        text, quotes, bars = analysis._run_trend_agent(llm, "AAPL")

    assert text == "Apple is trending up with low volatility."
    assert quotes == [_quote()]
    assert bars == [_bar()]


def test_run_fundamentals_agent_calls_tool_and_returns_text():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_company_fundamentals", "args": {"ticker": "AAPL"}, "id": "call1"},
        ]),
        AIMessage(content="Healthy margins, fair valuation.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_fundamentals_tool", return_value=("fund", _fundamentals())):
        text, fundamentals = analysis._run_fundamentals_agent(llm, "AAPL")

    assert text == "Healthy margins, fair valuation."
    assert fundamentals == _fundamentals()


def test_run_news_agent_calls_tool_and_returns_text():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="Sentiment is mostly positive.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_news_tool", return_value=("news", [_article()])):
        text, articles = analysis._run_news_agent(llm, "AAPL")

    assert text == "Sentiment is mostly positive."
    assert articles == [_article()]


def test_run_news_agent_reads_article_after_getting_its_url():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_stock_news", "args": {"tickers": ["AAPL"]}, "id": "call1"},
        ]),
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://example.com/a"}, "id": "call2"},
        ]),
        AIMessage(content="Detailed take using the full article.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_news_tool", return_value=("news", [_article()])), \
         patch("stoxlib.analysis.run_read_article_tool", return_value="full text") as mock_fetch:
        text, _ = analysis._run_news_agent(llm, "AAPL")

    mock_fetch.assert_called_once_with("https://example.com/a")
    assert text == "Detailed take using the full article."


def test_run_news_agent_refuses_to_read_an_unknown_url():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://evil.example/x"}, "id": "call1"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_read_article_tool") as mock_fetch:
        text, _ = analysis._run_news_agent(llm, "AAPL")

    mock_fetch.assert_not_called()
    assert text == "done"


def test_run_geopolitics_agent_calls_tool_and_returns_text():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_geopolitical_news",
             "args": {"query": "Taiwan chip export controls"}, "id": "call1"},
        ]),
        AIMessage(content="Export controls could pressure supply.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_geo_news_tool", return_value=("geo", [_geo_article()])):
        text, articles = analysis._run_geopolitics_agent(llm, "AAPL")

    assert text == "Export controls could pressure supply."
    assert articles == [_geo_article()]


def test_run_geopolitics_agent_reads_article_after_getting_its_url():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "get_geopolitical_news", "args": {"query": "Taiwan tariffs"}, "id": "call1"},
        ]),
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://example.com/g"}, "id": "call2"},
        ]),
        AIMessage(content="Detailed take using the full article.", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_geo_news_tool", return_value=("geo", [_geo_article()])), \
         patch("stoxlib.analysis.run_read_article_tool", return_value="full text") as mock_fetch:
        text, _ = analysis._run_geopolitics_agent(llm, "AAPL")

    mock_fetch.assert_called_once_with("https://example.com/g")
    assert text == "Detailed take using the full article."


def test_run_geopolitics_agent_refuses_to_read_an_unknown_url():
    llm = _FakeLLM([
        AIMessage(content="", tool_calls=[
            {"name": "read_article", "args": {"url": "https://evil.example/x"}, "id": "call1"},
        ]),
        AIMessage(content="done", tool_calls=[]),
    ])
    with patch("stoxlib.analysis.run_read_article_tool") as mock_fetch:
        text, _ = analysis._run_geopolitics_agent(llm, "AAPL")

    mock_fetch.assert_not_called()
    assert text == "done"


def test_run_specialist_forces_a_final_answer_after_max_tool_rounds():
    """A model that spends every round on a tool call (e.g. reading several
    articles one at a time) must still end up with a real answer, not a
    placeholder that would render as if it were genuine analysis --
    exceeding the budget forces one last tools-unbound call instead."""
    llm = _FakeLLM(
        [
            AIMessage(content="", tool_calls=[{"name": "noop", "args": {}, "id": "c%d" % i}])
            for i in range(analysis.MAX_TOOL_ROUNDS)
        ]
        + [AIMessage(content="Here's what I found before running out of budget.", tool_calls=[])]
    )
    text = analysis._run_specialist(llm, "system", [], "prompt", dispatch=lambda n, a: "ok")

    assert text == "Here's what I found before running out of budget."
    # the forced final call's last message must be the budget notice, not
    # another tool result -- confirms it happens after the loop gives up,
    # not as just another iteration of it
    final_call_messages = llm.received_messages[-1]
    assert final_call_messages[-1].content == analysis._BUDGET_EXHAUSTED_NOTICE


# -- aggregator -------------------------------------------------------------

def test_aggregator_system_prompt_unchanged_with_no_considerations():
    assert analysis._aggregator_system_prompt() == analysis.AGGREGATOR_SYSTEM


def test_aggregator_system_prompt_appends_stored_considerations():
    considerations.add_consideration("always factor in insider selling")
    prompt = analysis._aggregator_system_prompt()
    assert prompt.startswith(analysis.AGGREGATOR_SYSTEM)
    assert "always factor in insider selling" in prompt


def test_run_aggregator_sends_all_four_analyses_and_returns_verdict():
    llm = _FakeLLM([AIMessage(content="Low risk, favorable lean.", tool_calls=[])])

    text = analysis._run_aggregator(
        llm, "AAPL", "trend text", "fundamentals text", "news text", "geopolitics text")

    assert text == "Low risk, favorable lean."
    sent_prompt = llm.received_messages[0][1].content
    assert "trend text" in sent_prompt
    assert "fundamentals text" in sent_prompt
    assert "news text" in sent_prompt
    assert "geopolitics text" in sent_prompt
    assert "AAPL" in sent_prompt


# -- orchestration ------------------------------------------------------

def test_run_stock_analysis_runs_all_five_agents_in_order():
    seen = []
    with patch("stoxlib.analysis._run_trend_agent", return_value=("trend", [_quote()], [_bar()])), \
         patch("stoxlib.analysis._run_fundamentals_agent", return_value=("fund", _fundamentals())), \
         patch("stoxlib.analysis._run_news_agent", return_value=("news", [_article()])), \
         patch("stoxlib.analysis._run_geopolitics_agent", return_value=("geo", [_geo_article()])), \
         patch("stoxlib.analysis._run_aggregator", return_value="verdict"):
        result = analysis.run_stock_analysis(
            "AAPL", llm=Mock(), on_agent_start=seen.append,
        )

    assert seen == ["trend", "fundamentals", "news", "geopolitics", "aggregator"]
    assert result.error is None
    assert result.ticker == "AAPL"
    assert result.trend_text == "trend"
    assert result.fundamentals_text == "fund"
    assert result.news_text == "news"
    assert result.geopolitics_text == "geo"
    assert result.verdict_text == "verdict"
    assert result.quotes == [_quote()]
    assert result.bars == [_bar()]
    assert result.articles == [_article()]
    assert result.geo_articles == [_geo_article()]
    assert result.fundamentals == _fundamentals()


def test_run_stock_analysis_runs_specialists_concurrently():
    """trend/fundamentals/news/geopolitics hit independent data sources and
    don't depend on each other's output, so they should overlap in wall
    time instead of summing -- each sleeps briefly and records when it ran;
    if they were sequential the total would be roughly 4x one sleep."""
    import time

    def _slow(result, sleep=0.05):
        def _run(llm, ticker, on_tool_call=None):
            time.sleep(sleep)
            return result
        return _run

    with patch("stoxlib.analysis._run_trend_agent", side_effect=_slow(("trend", [], []))), \
         patch("stoxlib.analysis._run_fundamentals_agent", side_effect=_slow(("fund", None))), \
         patch("stoxlib.analysis._run_news_agent", side_effect=_slow(("news", []))), \
         patch("stoxlib.analysis._run_geopolitics_agent", side_effect=_slow(("geo", []))), \
         patch("stoxlib.analysis._run_aggregator", return_value="verdict"):
        start = time.time()
        result = analysis.run_stock_analysis("AAPL", llm=Mock())
        elapsed = time.time() - start

    assert result.error is None
    assert elapsed < 0.15  # well under 4x the 0.05s sleep if run sequentially


def test_run_stock_analysis_attributes_tool_calls_to_the_right_specialist():
    """on_tool_call for run_stock_analysis carries a leading agent_name
    (unlike agent.ask_agent's plain on_tool_call(name, args)) so a caller
    can tell which of the four concurrent specialists made a given call."""
    seen = []

    def _fake_trend(llm, ticker, on_tool_call=None):
        if on_tool_call:
            on_tool_call("get_price_history", {"ticker": ticker})
        return "trend", [_quote()], [_bar()]

    def _fake_fundamentals(llm, ticker, on_tool_call=None):
        if on_tool_call:
            on_tool_call("get_company_fundamentals", {"ticker": ticker})
        return "fund", _fundamentals()

    def _fake_news(llm, ticker, on_tool_call=None):
        if on_tool_call:
            on_tool_call("get_stock_news", {"tickers": [ticker]})
        return "news", [_article()]

    def _fake_geopolitics(llm, ticker, on_tool_call=None):
        if on_tool_call:
            on_tool_call("get_geopolitical_news", {"query": ticker})
        return "geo", [_geo_article()]

    with patch("stoxlib.analysis._run_trend_agent", side_effect=_fake_trend), \
         patch("stoxlib.analysis._run_fundamentals_agent", side_effect=_fake_fundamentals), \
         patch("stoxlib.analysis._run_news_agent", side_effect=_fake_news), \
         patch("stoxlib.analysis._run_geopolitics_agent", side_effect=_fake_geopolitics), \
         patch("stoxlib.analysis._run_aggregator", return_value="verdict"):
        analysis.run_stock_analysis("AAPL", llm=Mock(), on_tool_call=lambda *a: seen.append(a))

    assert sorted(seen) == sorted([
        ("trend", "get_price_history", {"ticker": "AAPL"}),
        ("fundamentals", "get_company_fundamentals", {"ticker": "AAPL"}),
        ("news", "get_stock_news", {"tickers": ["AAPL"]}),
        ("geopolitics", "get_geopolitical_news", {"query": "AAPL"}),
    ])


def test_run_stock_analysis_builds_llm_when_none_given_and_reports_agent_error():
    result = analysis.run_stock_analysis("AAPL")
    assert result.error is not None
    assert "ANTHROPIC_API_KEY" in result.error


def test_run_stock_analysis_wraps_unexpected_exceptions():
    """The four specialists run concurrently in separate threads, so
    fundamentals/news/geopolitics are patched too -- otherwise, with only
    trend mocked to raise, they'd run for real against the Mock() llm in
    the background (harmlessly discarded once trend's exception wins the
    race, but not something a test should rely on)."""
    with patch("stoxlib.analysis._run_trend_agent", side_effect=RuntimeError("boom")), \
         patch("stoxlib.analysis._run_fundamentals_agent", return_value=("fund", _fundamentals())), \
         patch("stoxlib.analysis._run_news_agent", return_value=("news", [_article()])), \
         patch("stoxlib.analysis._run_geopolitics_agent", return_value=("geo", [_geo_article()])):
        result = analysis.run_stock_analysis("AAPL", llm=Mock())

    assert result.error == "analysis error: boom"


def test_run_analyze_stock_tool_formats_all_five_sections():
    fake_result = analysis.AnalysisResult(
        ticker="AAPL", trend_text="trend text", fundamentals_text="fund text",
        news_text="news text", geopolitics_text="geo text", verdict_text="verdict text",
    )
    with patch("stoxlib.analysis.run_stock_analysis", return_value=fake_result):
        text, result = analysis.run_analyze_stock_tool("AAPL")

    assert "trend text" in text
    assert "fund text" in text
    assert "news text" in text
    assert "geo text" in text
    assert "verdict text" in text
    assert result is fake_result


def test_run_analyze_stock_tool_surfaces_error_and_returns_no_result():
    fake_result = analysis.AnalysisResult(ticker="AAPL", error="access denied")
    with patch("stoxlib.analysis.run_stock_analysis", return_value=fake_result):
        text, result = analysis.run_analyze_stock_tool("AAPL")

    assert text == "error: access denied"
    assert result is None
