"""Natural-language question handling.

Resolves a plain-English question ("what's apple trading at today?" or
"any news on tesla?") into tool calls against the quote and news data
sources via LangChain tool use. Returns data (AgentResult), never prints --
shell.py owns all console output, so this module has no UI dependency and
no reason to change when the console formatting does.
"""

from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from .news import NewsError, fetch_news
from .providers import AgentError, build_llm
from .quotes import QuoteError, fetch_quotes
from .webfetch import FetchError, fetch_article_text

AGENT_SYSTEM = (
    "You are stox, a terse terminal research assistant for stocks, crypto, "
    "and FX. Translate company names to tickers yourself (Apple -> AAPL, "
    "Tesla -> TSLA, Microsoft -> MSFT, ...). Call get_stock_quote for price "
    "questions, and get_stock_news for questions about news, headlines, or "
    "what's going on with a company -- call both if the user asks for both. "
    "get_stock_news only returns a short summary of each article; if that "
    "isn't enough to answer the question (you need a specific number, deal "
    "term, or other detail it doesn't cover), call read_article with the "
    "exact url of the most relevant article from get_stock_news's results "
    "to read its full text -- you can only read urls that came from "
    "get_stock_news, not urls from anywhere else. Answer in one or two "
    "short sentences using what the tools return. Don't repeat raw tool "
    "output verbatim and don't restate a full table or headline list -- a "
    "detailed panel is printed to the console right after your answer."
)


@dataclass
class AgentResult:
    text: str = ""
    quotes: list = field(default_factory=list)
    articles: list = field(default_factory=list)
    error: str | None = None


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


def ask_agent(query, llm=None):
    """Resolve a natural-language query into an AgentResult.

    `llm` is injectable (tests can pass a fake chat model); by default it's
    built from the configured provider.
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AgentResult(error=str(e))

    llm_with_tools = llm.bind_tools([get_stock_quote, get_stock_news, read_article])
    messages = [SystemMessage(content=AGENT_SYSTEM), HumanMessage(content=query)]
    last_quotes = []
    last_articles = []
    # Only urls that get_stock_news actually returned in this conversation
    # may be read -- the model can't direct us to fetch an arbitrary url.
    known_article_urls = set()

    try:
        while True:
            ai_msg = llm_with_tools.invoke(messages)
            messages.append(ai_msg)

            if not ai_msg.tool_calls:
                text = ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content)
                return AgentResult(text=text, quotes=last_quotes, articles=last_articles)

            for call in ai_msg.tool_calls:
                args = call["args"]
                if call["name"] == "get_stock_quote":
                    result_text, quotes = run_quote_tool(args.get("tickers", []))
                    last_quotes = quotes or last_quotes
                elif call["name"] == "get_stock_news":
                    result_text, articles = run_news_tool(args.get("tickers", []), limit=args.get("limit", 5))
                    last_articles = articles or last_articles
                    known_article_urls.update(a.link for a in articles if a.link)
                elif call["name"] == "read_article":
                    url = args.get("url", "")
                    if url not in known_article_urls:
                        result_text = "error: url must be one get_stock_news returned in this conversation"
                    else:
                        result_text = run_read_article_tool(url)
                else:
                    result_text = "unknown tool"
                messages.append(ToolMessage(content=result_text, tool_call_id=call["id"]))
    except Exception as e:
        return AgentResult(error="agent error: %s" % e)
