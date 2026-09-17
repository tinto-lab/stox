"""Natural-language question handling.

Resolves a plain-English question ("what's apple trading at today?" or
"any news on tesla?") into tool calls against the quote and news data
sources via LangChain tool use. Returns data (AgentResult), never prints --
shell.py owns all console output, so this module has no UI dependency and
no reason to change when the console formatting does.
"""

import re
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from .considerations import add_consideration, load_considerations
from .fundamentals import FundamentalsError, fetch_fundamentals
from .history import HistoryError, fetch_history
from .news import NewsError, fetch_news
from .providers import AgentError, build_llm
from .quotes import QuoteError, fetch_quotes
from .webfetch import FetchError, fetch_article_text

AGENT_SYSTEM = (
    "You are stox, a terse terminal research assistant for stocks, crypto, "
    "and FX. The user may ask in any language -- reply in that same "
    "language, regardless of what language this prompt or the tools' "
    "output happen to be in. Translate company names to tickers yourself "
    "(Apple -> AAPL, Tesla -> TSLA, Microsoft -> MSFT, ...) -- this "
    "includes names given in another language or script (e.g. Nvidia's "
    "Chinese name). Every message, including a bare ticker or company name "
    "with no other wording, reaches you directly -- decide for yourself "
    "how much the user actually wants. A bare ticker/name, or a plain "
    "\"what's X trading at\", means they just want the price: call only "
    "get_stock_quote and answer with just that. Only reach for more tools "
    "when the wording asks for more. Call get_stock_quote for price "
    "questions, and get_stock_news for questions about news, headlines, or "
    "what's going on with a company -- call both if the user asks for both. "
    "Call get_price_history for questions about past performance or how a "
    "price has moved over time (e.g. \"how has apple done this month\", "
    "\"tesla's 6-month performance\", \"price a year ago\") -- pick `days` "
    "to cover the period asked about (a month is ~30, 6 months is ~180, a "
    "year is ~365). Call get_company_fundamentals for questions about "
    "profitability, valuation, or financial health (EBITDA, margins, "
    "revenue growth, P/E, and similar). get_stock_news only returns a "
    "short summary of each article; if that isn't enough to answer the "
    "question (you need a specific number, deal term, or other detail it "
    "doesn't cover), call read_article with the exact url of the most "
    "relevant article from get_stock_news's results to read its full text "
    "-- you can only read urls that came from get_stock_news, not urls "
    "from anywhere else. If the user asks whether to buy or sell "
    "something, wants a risk assessment, or asks for a full analysis of a "
    "company, call analyze_stock instead of the individual data tools -- "
    "it runs dedicated trend, fundamentals, and news agents and returns "
    "their findings plus an aggregated risk assessment. If the user asks "
    "you to "
    "always factor something in, keep something in mind, or remember a "
    "standing consideration for future 'why is it moving' or risk "
    "questions, call remember_consideration to save it permanently across "
    "sessions -- only for standing instructions about how you analyze, "
    "never for one-off facts like today's price. Answer in one or two "
    "short sentences using what the tools return. Don't repeat raw tool "
    "output verbatim and don't restate a full table or headline list -- a "
    "detailed panel is printed to the console right after your answer."
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


def run_quote_tool(tickers):
    """Fetch quotes and render them as tool-result text; also return the Quotes."""
    try:
        quotes, missing = fetch_quotes(tickers)
    except QuoteError as e:
        return "error: %s" % e, []

    lines = [
        "%s: price=%.2f change=%+.2f change_pct=%+.2f%% open=%.2f high=%.2f "
        "low=%.2f prev_close=%.2f volume=%.0f" % (
            q.code, q.price, q.change, q.percent, q.open, q.high, q.low,
            q.prev_close, q.volume,
        )
        for q in quotes
    ]
    lines += ["%s: no data (unknown symbol?)" % code for code in missing]
    return "\n".join(lines) or "no data", quotes


@tool
def get_stock_quote(tickers: list[str]) -> str:
    """Look up real-time price quotes for one or more tickers via EODHD.

    Bare symbols default to the US exchange (AAPL, TSLA). Use
    SYMBOL.EXCHANGE for anything else (BMW.XETRA, BTC-USD.CC, EURUSD.FOREX).
    """
    text, _ = run_quote_tool(tickers)
    return text


def run_history_tool(ticker, days=30):
    """Fetch historical OHLC bars and render them as tool-result text; also
    return the Bars. Kept to a summary plus the latest bar (not every row)
    so a long lookback doesn't flood the model with raw numbers."""
    try:
        bars = fetch_history(ticker, days=days)
    except HistoryError as e:
        return "error: %s" % e, []

    if not bars:
        return "no historical data found", []

    first, last = bars[0], bars[-1]
    change = last.close - first.close
    percent = (change / first.close * 100) if first.close else 0.0
    period_high = max(b.high for b in bars)
    period_low = min(b.low for b in bars)

    summary = (
        "%s %s..%s (%d bars): start=%.2f end=%.2f change=%+.2f "
        "change_pct=%+.2f%% period_high=%.2f period_low=%.2f" % (
            first.code, first.date[:10], last.date[:10], len(bars),
            first.close, last.close, change, percent, period_high, period_low,
        )
    )
    latest = (
        "latest: date=%s open=%.2f high=%.2f low=%.2f close=%.2f "
        "volume=%.0f" % (
            last.date[:10], last.open, last.high, last.low, last.close, last.volume,
        )
    )
    return summary + "\n" + latest, bars


@tool
def get_price_history(ticker: str, days: int = 30) -> str:
    """Look up historical daily OHLC prices for one ticker via EODHD.

    `days` is how far back to look from today (default 30). Use this for
    questions about past performance or price trends over time, not for
    the current price. Bare symbols default to the US exchange (AAPL, TSLA).
    """
    text, _ = run_history_tool(ticker, days=days)
    return text


def run_fundamentals_tool(ticker):
    """Fetch fundamentals and render them as tool-result text; also return
    the Fundamentals (or None)."""
    try:
        f = fetch_fundamentals(ticker)
    except FundamentalsError as e:
        return "error: %s" % e, None

    def _pct(v):
        return "%.2f%%" % (v * 100) if v is not None else "NA"

    def _num(v, fmt="%.2f"):
        return fmt % v if v is not None else "NA"

    text = (
        "%s (%s) sector=%s industry=%s market_cap=%s\n"
        "ebitda=%s revenue_ttm=%s eps=%s\n"
        "profit_margin=%s operating_margin=%s roe=%s roa=%s\n"
        "revenue_growth_yoy=%s earnings_growth_yoy=%s\n"
        "pe_ratio=%s peg_ratio=%s dividend_yield=%s analyst_target_price=%s" % (
            f.code, f.name, f.sector, f.industry, _num(f.market_cap, "%.0f"),
            _num(f.ebitda, "%.0f"), _num(f.revenue_ttm, "%.0f"), _num(f.eps),
            _pct(f.profit_margin), _pct(f.operating_margin), _pct(f.roe), _pct(f.roa),
            _pct(f.revenue_growth_yoy), _pct(f.earnings_growth_yoy),
            _num(f.pe_ratio), _num(f.peg_ratio), _pct(f.dividend_yield),
            _num(f.analyst_target_price),
        )
    )
    return text, f


@tool
def get_company_fundamentals(ticker: str) -> str:
    """Look up profitability and valuation fundamentals for one ticker via EODHD.

    Covers EBITDA, revenue, margins, ROE/ROA, growth rates, P/E, and
    analyst target price. Use this for questions about a company's
    financial health or valuation, not its current price or news. Bare
    symbols default to the US exchange (AAPL, TSLA).
    """
    text, _ = run_fundamentals_tool(ticker)
    return text


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


def run_news_tool(tickers, limit=5):
    """Fetch news and render it as tool-result text; also return the Articles."""
    try:
        articles = fetch_news(tickers, limit=limit)
    except NewsError as e:
        return "error: %s" % e, []

    if not articles:
        return "no recent news found", []

    blocks = [
        "date: %s\ntitle: %s\nurl: %s\nsummary: %s" % (
            (a.date or "")[:10], a.title, a.link, a.summary,
        )
        for a in articles
    ]
    return "\n---\n".join(blocks), articles


@tool
def get_stock_news(tickers: list[str], limit: int = 5) -> str:
    """Look up recent financial news headlines for one or more tickers via EODHD.

    Use this for questions about news, headlines, or what's going on with a
    company or stock -- separate from its price. Bare symbols default to the
    US exchange (AAPL, TSLA).
    """
    text, _ = run_news_tool(tickers, limit=limit)
    return text


UNKNOWN_ARTICLE_URL_ERROR = "error: url must be one get_stock_news returned in this conversation"


def run_read_article_tool(url):
    """Fetch and extract an article's full readable text as tool-result text."""
    try:
        return fetch_article_text(url)
    except FetchError as e:
        return "error: %s" % e


@tool
def read_article(url: str) -> str:
    """Read the full text of one news article, given its exact url.

    Only call this with a url that get_stock_news already returned in this
    conversation -- use it when that article's short summary doesn't cover
    what the question needs.
    """
    return run_read_article_tool(url)


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


def ask_agent(query, history=None, llm=None, on_tool_call=None):
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
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AgentResult(error=str(e))

    if history is None:
        history = []

    # Imported here, not at module level, to avoid a circular import --
    # analysis.py itself imports several tools from this module.
    from .analysis import analyze_stock, run_analyze_stock_tool

    llm_with_tools = llm.bind_tools(
        [get_stock_quote, get_stock_news, get_price_history, get_company_fundamentals,
         analyze_stock, read_article, remember_consideration]
    )
    messages = [SystemMessage(content=_build_system_prompt())] + history + [HumanMessage(content=query)]
    last_quotes = []
    last_articles = []
    last_bars = []
    last_fundamentals = None
    last_analysis = None
    # Only urls that get_stock_news actually returned (this turn or an
    # earlier one still in history) may be read -- the model can't direct
    # us to fetch an arbitrary url.
    known_article_urls = _article_urls_in(history)

    try:
        while True:
            ai_msg = llm_with_tools.invoke(messages)
            messages.append(ai_msg)

            if not ai_msg.tool_calls:
                text = ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content)
                history[:] = messages[1:]  # drop the system message, keep the rest
                _trim_history(history)
                return AgentResult(text=text, quotes=last_quotes, articles=last_articles,
                                    bars=last_bars, fundamentals=last_fundamentals,
                                    analysis=last_analysis)

            for call in ai_msg.tool_calls:
                args = call["args"]
                if on_tool_call is not None:
                    on_tool_call(call["name"], args)
                if call["name"] == "get_stock_quote":
                    result_text, quotes = run_quote_tool(args.get("tickers", []))
                    last_quotes = quotes or last_quotes
                elif call["name"] == "get_stock_news":
                    result_text, articles = run_news_tool(args.get("tickers", []), limit=args.get("limit", 5))
                    last_articles = articles or last_articles
                    known_article_urls.update(a.link for a in articles if a.link)
                elif call["name"] == "get_price_history":
                    result_text, bars = run_history_tool(args.get("ticker", ""), days=args.get("days", 30))
                    last_bars = bars or last_bars
                elif call["name"] == "get_company_fundamentals":
                    result_text, fundamentals = run_fundamentals_tool(args.get("ticker", ""))
                    last_fundamentals = fundamentals or last_fundamentals
                elif call["name"] == "analyze_stock":
                    result_text, analysis_result = run_analyze_stock_tool(args.get("ticker", ""), llm=llm)
                    if analysis_result is not None:
                        last_analysis = analysis_result
                        last_quotes = analysis_result.quotes or last_quotes
                        last_bars = analysis_result.bars or last_bars
                        last_articles = analysis_result.articles or last_articles
                        last_fundamentals = analysis_result.fundamentals or last_fundamentals
                elif call["name"] == "read_article":
                    url = args.get("url", "")
                    if url not in known_article_urls:
                        result_text = UNKNOWN_ARTICLE_URL_ERROR
                    else:
                        result_text = run_read_article_tool(url)
                elif call["name"] == "remember_consideration":
                    result_text = run_remember_consideration_tool(args.get("text", ""))
                else:
                    result_text = "unknown tool"
                messages.append(ToolMessage(content=result_text, tool_call_id=call["id"]))
    except Exception as e:
        return AgentResult(error="agent error: %s" % e)
