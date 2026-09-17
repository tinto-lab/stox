"""Multi-agent stock analysis: trend, fundamentals, and news specialists
feeding into a risk-assessment aggregator.

Each specialist is its own LLM call with a narrow system prompt and its own
slice of the tool surface from tools.py (reused, not duplicated), so a
change to how one analyzes doesn't ripple into the others. The aggregator
sees only their written findings, not the raw tool data, and never calls
tools itself -- it synthesizes, it doesn't investigate.

Returns data (AnalysisResult), never prints -- same rule as agent.py.
"""

from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool

from .considerations import load_considerations
from .providers import AgentError, build_llm
from .tool_loop import run_tool_loop
from .tools import (UNKNOWN_ARTICLE_URL_ERROR, get_company_fundamentals,
                     get_price_history, get_stock_news, get_stock_quote,
                     read_article, run_fundamentals_tool, run_history_tool,
                     run_news_tool, run_quote_tool, run_read_article_tool)

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
    "You are stox's news analyst. Given a ticker, call get_stock_news to "
    "see recent headlines. If a headline needs more depth to judge its "
    "significance, call read_article with its exact url from "
    "get_stock_news's results -- only urls that came from get_stock_news, "
    "not urls from anywhere else. In 2-4 sentences, summarize the "
    "sentiment and any notable catalysts or risks in the news. Don't give "
    "a buy/sell verdict -- that's someone else's job."
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


AGGREGATOR_SYSTEM = (
    "You are stox's aggregator. You're given a trend analysis, a "
    "fundamentals analysis, and a news analysis for one ticker, each "
    "written by a specialist who didn't see the others' work and has no "
    "tools of its own. Synthesize a risk assessment: 2-3 bullish factors, "
    "2-3 bearish/risk factors, an overall risk level (low/medium/high), "
    "and a directional lean (favorable/neutral/cautious). This is a "
    "framework for the user's own decision, not a directive to buy or "
    "sell, and not personalized financial advice. Weigh any standing "
    "considerations listed below. Keep it tight: plain text, short bullet "
    "lines, no markdown headers -- the three source analyses are shown to "
    "the user separately, so don't just repeat them."
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


def _run_aggregator(llm, ticker, trend_text, fundamentals_text, news_text):
    prompt = (
        "Ticker: %s\n\nTrend analysis:\n%s\n\nFundamentals analysis:\n%s\n\n"
        "News analysis:\n%s" % (ticker, trend_text, fundamentals_text, news_text)
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
    verdict_text: str = ""
    quotes: list = field(default_factory=list)
    bars: list = field(default_factory=list)
    articles: list = field(default_factory=list)
    fundamentals: object = None
    error: str | None = None


def run_stock_analysis(ticker, llm=None, on_agent_start=None, on_tool_call=None):
    """Run the trend, fundamentals, and news specialist agents for `ticker`
    in sequence, then the aggregator, returning an AnalysisResult.

    `llm` is injectable (tests can pass a fake chat model); by default it's
    built from the configured provider. All four agents share this one
    model -- "separate agents" here means separate system prompts, tool
    access, and LLM calls, not separate providers.

    `on_agent_start`, if given, is called as `on_agent_start(name)` with
    one of "trend", "fundamentals", "news", "aggregator" right before that
    agent starts, so the caller can show progress. `on_tool_call` is
    forwarded to each specialist the same way agent.ask_agent uses it.
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AnalysisResult(ticker=ticker, error=str(e))

    try:
        if on_agent_start is not None:
            on_agent_start("trend")
        trend_text, quotes, bars = _run_trend_agent(llm, ticker, on_tool_call)

        if on_agent_start is not None:
            on_agent_start("fundamentals")
        fundamentals_text, fundamentals = _run_fundamentals_agent(llm, ticker, on_tool_call)

        if on_agent_start is not None:
            on_agent_start("news")
        news_text, articles = _run_news_agent(llm, ticker, on_tool_call)

        if on_agent_start is not None:
            on_agent_start("aggregator")
        verdict_text = _run_aggregator(llm, ticker, trend_text, fundamentals_text, news_text)
    except Exception as e:
        return AnalysisResult(ticker=ticker, error="analysis error: %s" % e)

    return AnalysisResult(
        ticker=ticker, trend_text=trend_text, fundamentals_text=fundamentals_text,
        news_text=news_text, verdict_text=verdict_text, quotes=quotes, bars=bars,
        articles=articles, fundamentals=fundamentals,
    )


def run_analyze_stock_tool(ticker, llm=None):
    """Run the full multi-agent analysis and render it as tool-result text
    for the main agent; also return the AnalysisResult (or None on error)."""
    result = run_stock_analysis(ticker, llm=llm)
    if result.error:
        return "error: %s" % result.error, None

    text = (
        "trend: %s\n\nfundamentals: %s\n\nnews: %s\n\nrisk_assessment: %s" % (
            result.trend_text, result.fundamentals_text, result.news_text,
            result.verdict_text,
        )
    )
    return text, result


@tool
def analyze_stock(ticker: str) -> str:
    """Run a full multi-agent analysis of one ticker: dedicated trend,
    fundamentals, and news agents each produce a focused analysis, then an
    aggregator combines them into a risk assessment (bullish/bearish
    factors, an overall risk level, and a directional lean).

    Use this for buy/sell/risk questions or requests for a full analysis --
    it's slower than the individual data tools (it makes several LLM
    calls), so don't call it just for a simple price or news lookup.
    """
    text, _ = run_analyze_stock_tool(ticker)
    return text
