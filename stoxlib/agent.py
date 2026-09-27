"""Natural-language question handling.

Resolves a plain-English question ("what's apple trading at today?" or
"any news on tesla?") into tool calls against the quote and news data
sources via LangChain tool use. Returns data (AgentResult), never prints --
shell.py owns all console output, so this module has no UI dependency and
no reason to change when the console formatting does.
"""

import re
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from . import analysis
from .considerations import add_consideration, load_considerations
from .providers import AgentError, build_llm
from .tool_loop import run_tool_loop
from .tools import (UNKNOWN_ARTICLE_URL_ERROR, get_company_fundamentals,
                     get_geopolitical_news, get_price_history,
                     get_stock_news, get_stock_quote, read_article,
                     run_fundamentals_tool, run_geo_news_tool,
                     run_history_tool, run_news_tool, run_quote_tool,
                     run_read_article_tool)

AGENT_SYSTEM = (
    "You are stox, a terse terminal research assistant for stocks, crypto, "
    "and FX. Reply in the user's language. Map company names in any "
    "language or script to tickers yourself (Apple -> AAPL). Fetch only "
    "what the question asks for: a bare ticker or company name just wants "
    "the price. For buy/sell, risk, or full-analysis questions, call "
    "analyze_stock instead of the individual data tools. Answer in one or "
    "two short sentences -- a detailed panel of the tool data is printed "
    "right after your answer, so don't restate it."
)


def _build_system_prompt():
    """AGENT_SYSTEM plus any standing considerations stored on disk.

    Read fresh on every call (not cached at import time) so a
    consideration remembered mid-session applies to this same session's
    later turns too, not just future ones.
    """
    considerations = load_considerations()
    if not considerations:
        return AGENT_SYSTEM
    bullets = "\n".join("- %s" % c for c in considerations)
    return AGENT_SYSTEM + (
        "\n\nStanding considerations the user has asked you to always "
        "weigh when explaining why a price might be moving or assessing "
        "risk for a security (these persist across sessions):\n%s" % bullets
    )


@dataclass
class AgentResult:
    text: str = ""
    quotes: list = field(default_factory=list)
    articles: list = field(default_factory=list)
    geo_articles: list = field(default_factory=list)
    bars: list = field(default_factory=list)
    fundamentals: object = None
    analysis: object = None
    error: str | None = None


MAX_HISTORY_TURNS = 6


def _trim_history(history):
    """Drop the oldest whole turns once history exceeds MAX_HISTORY_TURNS,
    so it stays bounded without ever splitting a tool call from its
    result -- a turn always starts at a HumanMessage, so that's the only
    safe place to cut.
    """
    human_indices = [i for i, m in enumerate(history) if isinstance(m, HumanMessage)]
    if len(human_indices) > MAX_HISTORY_TURNS:
        cutoff = human_indices[-MAX_HISTORY_TURNS]
        del history[:cutoff]


def record_analysis(history, ticker, result):
    """Append a /analyze run to `history` as if the agent had called
    analyze_stock itself, so follow-ups ("why is the risk high?", "read
    that tariff article") can build on it.

    Shaped as a real tool-call turn -- user message, AIMessage carrying the
    analyze_stock call, its ToolMessage, a short final answer -- rather than
    a bare question/answer pair, so it matches what the model sees on the
    ask_agent path and _article_urls_in finds the source urls in the
    ToolMessage. Trimmed like any other turn.
    """
    call_id = "analyze_%d" % len(history)
    history.extend([
        HumanMessage(content="/analyze %s" % ticker),
        AIMessage(content="", tool_calls=[
            {"name": "analyze_stock", "args": {"ticker": ticker}, "id": call_id},
        ]),
        ToolMessage(content=analysis.format_analysis_for_agent(result), tool_call_id=call_id),
        AIMessage(content="Full analysis of %s is shown above." % ticker),
    ])
    _trim_history(history)


_URL_LINE_RE = re.compile(r"^url: (\S+)$", re.MULTILINE)


def _article_urls_in(messages):
    """Recover article urls from get_stock_news tool results in `messages`,
    by matching the "url: ..." lines run_news_tool's output uses. Lets
    read_article's allow-list cover articles surfaced in earlier turns,
    not just this one.
    """
    urls = set()
    for m in messages:
        if isinstance(m, ToolMessage) and isinstance(m.content, str):
            urls.update(_URL_LINE_RE.findall(m.content))
    return urls


def run_remember_consideration_tool(text):
    """Store a standing consideration to disk as tool-result text."""
    text = (text or "").strip()
    if not text:
        return "error: nothing to remember"
    add_consideration(text)
    return "remembered: %s" % text


@tool
def remember_consideration(text: str) -> str:
    """Permanently remember a factor to always weigh when explaining why a
    price might be moving or assessing risk for a security.

    This persists across sessions, not just this conversation. Call it
    when the user says something like "always consider X", "keep Y in
    mind when talking about risk", or "remember this for next time" --
    not for one-off facts that aren't standing instructions.
    """
    return run_remember_consideration_tool(text)


def ask_agent(query, history=None, llm=None, on_tool_call=None,
              on_analysis_agent_start=None, on_analysis_tool_call=None):
    """Resolve a natural-language query into an AgentResult.

    `llm` is injectable (tests can pass a fake chat model); by default it's
    built from the configured provider.

    `history` is a mutable list of prior LangChain messages (no system
    message -- that's added fresh each call) carried over from earlier
    turns in the same conversation, e.g. so "what about its news?" can
    resolve "its" from the previous question. Pass the same list back in
    on the next call to keep the thread going; omit it for a one-off,
    stateless question. On success this turn's exchange (the user message,
    any tool calls/results, and the final answer) is appended to it in
    place, then trimmed to the most recent MAX_HISTORY_TURNS turns. On
    error, history is left untouched so a failed turn doesn't pollute
    context for the next one.

    `on_tool_call`, if given, is called as `on_tool_call(name, args)` right
    before each tool actually runs -- e.g. so the caller can print "calling
    get_stock_news(...)" for visibility into what the model is doing.

    `on_analysis_agent_start` and `on_analysis_tool_call` are the same
    progress callbacks for when the model calls analyze_stock -- passed
    through to run_stock_analysis as its `on_agent_start`/`on_tool_call`,
    so the specialists' work is as visible here as it is under /analyze.
    Note the analysis tool-call callback takes a leading agent_name and may
    be called concurrently from the specialists' threads.
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AgentResult(error=str(e))

    if history is None:
        history = []

    state = {"quotes": [], "articles": [], "geo_articles": [], "bars": [],
              "fundamentals": None, "analysis": None}
    # Only urls that get_stock_news/get_geopolitical_news actually returned
    # (this turn or an earlier one still in history) may be read -- the
    # model can't direct us to fetch an arbitrary url.
    known_article_urls = _article_urls_in(history)

    def dispatch(name, args):
        if name == "get_stock_quote":
            result_text, quotes = run_quote_tool(args.get("tickers", []))
            state["quotes"] = quotes or state["quotes"]
            return result_text
        if name == "get_stock_news":
            result_text, articles = run_news_tool(args.get("tickers", []), limit=args.get("limit", 5))
            state["articles"] = articles or state["articles"]
            known_article_urls.update(a.link for a in articles if a.link)
            return result_text
        if name == "get_geopolitical_news":
            result_text, geo_articles = run_geo_news_tool(args.get("query", ""), limit=args.get("limit", 5))
            state["geo_articles"] = geo_articles or state["geo_articles"]
            known_article_urls.update(a.link for a in geo_articles if a.link)
            return result_text
        if name == "get_price_history":
            result_text, bars = run_history_tool(args.get("ticker", ""), days=args.get("days", 30))
            state["bars"] = bars or state["bars"]
            return result_text
        if name == "get_company_fundamentals":
            result_text, fundamentals = run_fundamentals_tool(args.get("ticker", ""))
            state["fundamentals"] = fundamentals or state["fundamentals"]
            return result_text
        if name == "analyze_stock":
            result_text, analysis_result = analysis.run_analyze_stock_tool(
                args.get("ticker", ""), llm=llm, on_agent_start=on_analysis_agent_start,
                on_tool_call=on_analysis_tool_call)
            if analysis_result is not None:
                state["analysis"] = analysis_result
                state["quotes"] = analysis_result.quotes or state["quotes"]
                state["bars"] = analysis_result.bars or state["bars"]
                state["articles"] = analysis_result.articles or state["articles"]
                state["geo_articles"] = analysis_result.geo_articles or state["geo_articles"]
                state["fundamentals"] = analysis_result.fundamentals or state["fundamentals"]
            return result_text
        if name == "read_article":
            url = args.get("url", "")
            if url not in known_article_urls:
                return UNKNOWN_ARTICLE_URL_ERROR
            return run_read_article_tool(url)
        if name == "remember_consideration":
            return run_remember_consideration_tool(args.get("text", ""))
        return "unknown tool"

    messages = [SystemMessage(content=_build_system_prompt())] + history + [HumanMessage(content=query)]
    tools = [get_stock_quote, get_stock_news, get_geopolitical_news, get_price_history,
             get_company_fundamentals, analysis.analyze_stock, read_article, remember_consideration]

    try:
        text = run_tool_loop(llm, messages, tools, dispatch, on_tool_call=on_tool_call)
    except Exception as e:
        return AgentResult(error="agent error: %s" % e)

    history[:] = messages[1:]  # drop the system message, keep the rest
    _trim_history(history)
    return AgentResult(text=text, quotes=state["quotes"], articles=state["articles"],
                        geo_articles=state["geo_articles"], bars=state["bars"],
                        fundamentals=state["fundamentals"], analysis=state["analysis"])
