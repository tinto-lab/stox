"""Multi-agent stock analysis: trend, fundamentals, news, and geopolitics
specialists feeding into a risk-assessment aggregator.

Each specialist is its own LLM call with a narrow system prompt and its own
slice of the tool surface from tools.py (reused, not duplicated), so a
change to how one analyzes doesn't ripple into the others. The aggregator
sees only their written findings, not the raw tool data, and never calls
tools itself -- it synthesizes, it doesn't investigate.

Returns data (AnalysisResult), never prints -- same rule as agent.py.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool

from .considerations import load_considerations
from .providers import AgentError, build_llm
from .tool_loop import run_tool_loop
from .tools import (UNKNOWN_ARTICLE_URL_ERROR, get_company_fundamentals,
                     get_geopolitical_news, get_price_history,
                     get_stock_news, get_stock_quote, read_article,
                     run_fundamentals_tool, run_geo_news_tool,
                     run_history_tool, run_news_tool, run_quote_tool,
                     run_read_article_tool)

MAX_TOOL_ROUNDS = 6

_BUDGET_EXHAUSTED_NOTICE = (
    "You've used up your tool-call budget. Answer now, in 2-4 sentences, "
    "using only what you've already found above -- no more tool calls."
)


def _run_specialist(llm, system_prompt, tools, user_prompt, dispatch, on_tool_call=None):
    """Run one specialist agent: asks `user_prompt`, runs any tool calls
    through `dispatch(name, args) -> result_text`, and returns the model's
    final text once it stops calling tools.

    MAX_TOOL_ROUNDS counts LLM invocations, not tool calls before an
    answer -- a model that reads a couple of articles one at a time (e.g.
    get_stock_news, then read_article, then read_article again) can easily
    spend every round on a tool call and never reach a round with no
    tool_calls to return. Rather than let that read as "no answer" (a
    placeholder that would render as if it were real analysis), the budget
    running out forces one last call with no tools bound, so the model
    must write up whatever it already gathered instead of us fabricating
    a failure message.
    """
    messages = [SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)]
    return run_tool_loop(llm, messages, tools, dispatch, on_tool_call=on_tool_call,
                          max_rounds=MAX_TOOL_ROUNDS,
                          budget_exhausted_notice=_BUDGET_EXHAUSTED_NOTICE)


TREND_AGENT_SYSTEM = (
    "You are stox's trend analyst. Given a ticker, call get_price_history "
    "(days=90 is a good default unless the question implies a different "
    "window) to see how the price has moved, and get_stock_quote for "
    "today's price and change. In 2-4 sentences, describe the trend: "
    "direction, momentum, volatility, and where the price sits versus its "
    "recent high/low range. Don't give a buy/sell verdict -- that's "
    "someone else's job."
)


def _run_trend_agent(llm, ticker, on_tool_call=None):
    state = {"quotes": [], "bars": []}

    def dispatch(name, args):
        if name == "get_stock_quote":
            text, quotes = run_quote_tool(args.get("tickers") or [ticker])
            state["quotes"] = quotes or state["quotes"]
            return text
        if name == "get_price_history":
            text, bars = run_history_tool(args.get("ticker") or ticker, days=args.get("days", 90))
            state["bars"] = bars or state["bars"]
            return text
        return "unknown tool"

    text = _run_specialist(
        llm, TREND_AGENT_SYSTEM, [get_stock_quote, get_price_history],
        "Analyze the price trend for %s." % ticker, dispatch, on_tool_call,
    )
    return text, state["quotes"], state["bars"]


FUNDAMENTALS_AGENT_SYSTEM = (
    "You are stox's fundamentals analyst. Given a ticker, call "
    "get_company_fundamentals and assess the company's profitability and "
    "valuation in 2-4 sentences: margins, EBITDA, revenue/earnings growth, "
    "and whether the valuation (P/E, PEG) looks rich or cheap. Don't give "
    "a buy/sell verdict -- that's someone else's job."
)


def _run_fundamentals_agent(llm, ticker, on_tool_call=None):
    state = {"fundamentals": None}

    def dispatch(name, args):
        if name == "get_company_fundamentals":
            text, fundamentals = run_fundamentals_tool(args.get("ticker") or ticker)
            state["fundamentals"] = fundamentals or state["fundamentals"]
            return text
        return "unknown tool"

    text = _run_specialist(
        llm, FUNDAMENTALS_AGENT_SYSTEM, [get_company_fundamentals],
        "Analyze the fundamentals for %s." % ticker, dispatch, on_tool_call,
    )
    return text, state["fundamentals"]


NEWS_AGENT_SYSTEM = (
    "You are stox's news analyst. Given a ticker, call get_stock_news and "
    "summarize in 2-4 sentences the sentiment and any notable catalysts or "
    "risks. Don't give a buy/sell verdict -- that's someone else's job."
)


def _run_news_agent(llm, ticker, on_tool_call=None):
    state = {"articles": [], "known_urls": set()}

    def dispatch(name, args):
        if name == "get_stock_news":
            text, articles = run_news_tool(args.get("tickers") or [ticker], limit=args.get("limit", 5))
            state["articles"] = articles or state["articles"]
            state["known_urls"].update(a.link for a in articles if a.link)
            return text
        if name == "read_article":
            url = args.get("url", "")
            if url not in state["known_urls"]:
                return UNKNOWN_ARTICLE_URL_ERROR
            return run_read_article_tool(url)
        return "unknown tool"

    text = _run_specialist(
        llm, NEWS_AGENT_SYSTEM, [get_stock_news, read_article],
        "Analyze recent news for %s." % ticker, dispatch, on_tool_call,
    )
    return text, state["articles"]


MAX_GEO_SEARCHES = 3

GEOPOLITICS_AGENT_SYSTEM = (
    "You are stox's geopolitics analyst. Given a ticker, work out which "
    "countries, supply chains, commodities, and regulators the company is "
    "exposed to, then search get_geopolitical_news for those angles. You "
    "have a budget of %d searches: pick the angles that matter most, keep "
    "each query to a few key words (long queries tend to match nothing), "
    "and make all the searches together in your first response. In 2-4 "
    "sentences, explain what geopolitical or macro forces could move this "
    "stock and how -- say plainly if nothing relevant turns up. Don't "
    "mention your search budget. Don't give a buy/sell verdict -- that's "
    "someone else's job." % MAX_GEO_SEARCHES
)


_GEO_SEARCH_BUDGET_NOTICE = (
    "error: you've used up your %d searches for this run -- work with what "
    "you already have instead of searching again" % MAX_GEO_SEARCHES
)


def _run_geopolitics_agent(llm, ticker, on_tool_call=None):
    state = {"articles": [], "known_urls": set(), "searches": 0}

    def dispatch(name, args):
        if name == "get_geopolitical_news":
            if state["searches"] >= MAX_GEO_SEARCHES:
                return _GEO_SEARCH_BUDGET_NOTICE
            state["searches"] += 1
            text, articles = run_geo_news_tool(args.get("query") or ticker, limit=args.get("limit", 5))
            state["articles"] = articles or state["articles"]
            state["known_urls"].update(a.link for a in articles if a.link)
            return text
        if name == "read_article":
            url = args.get("url", "")
            if url not in state["known_urls"]:
                return UNKNOWN_ARTICLE_URL_ERROR
            return run_read_article_tool(url)
        return "unknown tool"

    text = _run_specialist(
        llm, GEOPOLITICS_AGENT_SYSTEM, [get_geopolitical_news, read_article],
        "Analyze geopolitical and macro risk for %s." % ticker, dispatch, on_tool_call,
    )
    return text, state["articles"]


AGGREGATOR_SYSTEM = (
    "You are stox's aggregator. You're given a trend analysis, a "
    "fundamentals analysis, a news analysis, and a geopolitical analysis "
    "for one ticker, each written by a specialist who didn't see the "
    "others' work and has no tools of its own. Synthesize a risk "
    "assessment: 2-3 bullish factors, 2-3 bearish/risk factors, an overall "
    "risk level (low/medium/high), and a directional lean "
    "(favorable/neutral/cautious). Fold in the geopolitical analysis "
    "where it's actually relevant -- don't force a connection if that "
    "specialist found nothing notable. Then give a clear verdict line "
    "(Buy, Hold, or Sell) with a one-line reason, and a price outlook: a "
    "target price or range over roughly the next 3-6 months with your "
    "confidence (low/medium/high). Commit to a call -- don't hedge it "
    "away or refuse; the user sees a separate disclaimer. Weigh any "
    "standing considerations listed below. "
    "Keep it tight: plain text, short bullet lines, no markdown headers "
    "-- the four source analyses are shown to the user separately, so "
    "don't just repeat them."
)


def _aggregator_system_prompt():
    """AGGREGATOR_SYSTEM plus any standing considerations stored on disk,
    read fresh each call so a consideration remembered mid-session applies
    immediately -- mirrors agent.py's _build_system_prompt."""
    considerations = load_considerations()
    if not considerations:
        return AGGREGATOR_SYSTEM
    bullets = "\n".join("- %s" % c for c in considerations)
    return AGGREGATOR_SYSTEM + "\n\nStanding considerations to weigh:\n%s" % bullets


def _run_aggregator(llm, ticker, trend_text, fundamentals_text, news_text, geopolitics_text):
    prompt = (
        "Ticker: %s\n\nTrend analysis:\n%s\n\nFundamentals analysis:\n%s\n\n"
        "News analysis:\n%s\n\nGeopolitical analysis:\n%s" % (
            ticker, trend_text, fundamentals_text, news_text, geopolitics_text,
        )
    )
    messages = [SystemMessage(content=_aggregator_system_prompt()), HumanMessage(content=prompt)]
    ai_msg = llm.invoke(messages)
    return ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content)


@dataclass
class AnalysisResult:
    ticker: str = ""
    trend_text: str = ""
    fundamentals_text: str = ""
    news_text: str = ""
    geopolitics_text: str = ""
    verdict_text: str = ""
    quotes: list = field(default_factory=list)
    bars: list = field(default_factory=list)
    articles: list = field(default_factory=list)
    geo_articles: list = field(default_factory=list)
    fundamentals: object = None
    error: str | None = None


def run_stock_analysis(ticker, llm=None, on_agent_start=None, on_tool_call=None):
    """Run the trend, fundamentals, news, and geopolitics specialist agents
    for `ticker` concurrently (each hits a different data source and
    doesn't depend on the others' output), then the aggregator once all
    four are done, returning an AnalysisResult.

    `llm` is injectable (tests can pass a fake chat model); by default it's
    built from the configured provider. All five agents share this one
    model -- "separate agents" here means separate system prompts, tool
    access, and LLM calls, not separate providers. The four specialists
    each call it from their own thread (via ThreadPoolExecutor, since the
    whole codebase is synchronous -- requests.get and llm.invoke, not
    async); LangChain chat models are safe to invoke concurrently from one
    shared instance the same way Runnable.batch() already does internally.

    `on_agent_start`, if given, is called as `on_agent_start(name)` with
    one of "trend", "fundamentals", "news", "geopolitics", "aggregator".
    Since the four specialists start together, all four fire (in that
    order, from the main thread) right before they're submitted to the
    pool, rather than one at a time as each actually begins -- there's no
    meaningful "started" instant to report per specialist once they're
    concurrent. "aggregator" still fires right before that call, once the
    other four have finished. `on_tool_call`, if given, is called as
    `on_tool_call(agent_name, tool_name, args)` -- note the extra leading
    agent_name versus agent.ask_agent's `on_tool_call(name, args)`, needed
    here so a caller printing progress can attribute an interleaved call
    to the specialist that made it. It may be called from any of the four
    specialist threads and must be safe to call concurrently (e.g. behind
    a lock if it prints to a shared console).
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AnalysisResult(ticker=ticker, error=str(e))

    def _tool_call_for(agent_name):
        if on_tool_call is None:
            return None
        return lambda name, args: on_tool_call(agent_name, name, args)

    try:
        if on_agent_start is not None:
            on_agent_start("trend")
            on_agent_start("fundamentals")
            on_agent_start("news")
            on_agent_start("geopolitics")

        with ThreadPoolExecutor(max_workers=4) as pool:
            trend_future = pool.submit(_run_trend_agent, llm, ticker, _tool_call_for("trend"))
            fundamentals_future = pool.submit(
                _run_fundamentals_agent, llm, ticker, _tool_call_for("fundamentals"))
            news_future = pool.submit(_run_news_agent, llm, ticker, _tool_call_for("news"))
            geopolitics_future = pool.submit(
                _run_geopolitics_agent, llm, ticker, _tool_call_for("geopolitics"))

            trend_text, quotes, bars = trend_future.result()
            fundamentals_text, fundamentals = fundamentals_future.result()
            news_text, articles = news_future.result()
            geopolitics_text, geo_articles = geopolitics_future.result()

        if on_agent_start is not None:
            on_agent_start("aggregator")
        verdict_text = _run_aggregator(
            llm, ticker, trend_text, fundamentals_text, news_text, geopolitics_text)
    except Exception as e:
        return AnalysisResult(ticker=ticker, error="analysis error: %s" % e)

    return AnalysisResult(
        ticker=ticker, trend_text=trend_text, fundamentals_text=fundamentals_text,
        news_text=news_text, geopolitics_text=geopolitics_text, verdict_text=verdict_text,
        quotes=quotes, bars=bars, articles=articles, geo_articles=geo_articles,
        fundamentals=fundamentals,
    )


def format_analysis_for_agent(result):
    """Render a successful AnalysisResult as tool-result text for the main
    agent -- used both when the agent calls analyze_stock itself and when
    /analyze's result is recorded into conversation history.

    Source article urls go on "url: ..." lines, the same format
    run_news_tool uses, so agent._article_urls_in recovers them and a
    follow-up "read that article" can pass read_article's allow-list.
    """
    text = (
        "trend: %s\n\nfundamentals: %s\n\nnews: %s\n\ngeopolitics: %s\n\n"
        "risk_assessment: %s" % (
            result.trend_text, result.fundamentals_text, result.news_text,
            result.geopolitics_text, result.verdict_text,
        )
    )
    sources = [a for a in result.articles + result.geo_articles if a.link]
    if sources:
        text += "\n\nsources:\n" + "\n".join(
            "title: %s\nurl: %s" % (a.title, a.link) for a in sources)
    return text


def run_analyze_stock_tool(ticker, llm=None, on_agent_start=None, on_tool_call=None):
    """Run the full multi-agent analysis and render it as tool-result text
    for the main agent; also return the AnalysisResult (or None on error).
    `on_agent_start` and `on_tool_call` are passed straight to
    run_stock_analysis -- see its docstring for their signatures."""
    result = run_stock_analysis(ticker, llm=llm, on_agent_start=on_agent_start,
                                on_tool_call=on_tool_call)
    if result.error:
        return "error: %s" % result.error, None
    return format_analysis_for_agent(result), result


@tool
def analyze_stock(ticker: str) -> str:
    """Run a full multi-agent analysis of one ticker: dedicated trend,
    fundamentals, news, and geopolitics agents each produce a focused
    analysis, then an aggregator combines them into a risk assessment
    (bullish/bearish factors, an overall risk level, a directional lean,
    a Buy/Hold/Sell verdict, and a price outlook).

    Use this for buy/sell/hold, price-prediction, or risk questions, or
    requests for a full analysis --
    it's slower than the individual data tools (it makes several LLM
    calls), so don't call it just for a simple price or news lookup.
    """
    text, _ = run_analyze_stock_tool(ticker)
    return text
