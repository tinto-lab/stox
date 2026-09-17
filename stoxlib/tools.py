"""Shared data-lookup tools: quotes, news, price history, fundamentals,
world/geopolitical news, and full-article text.

Used directly by agent.py's main chat agent and, with a narrower slice
each, by analysis.py's trend/fundamentals/news specialists -- kept here,
neutral of both, so neither module has to import the other just to reach
a tool definition.
"""

from .fundamentals import FundamentalsError, fetch_fundamentals
from .history import HistoryError, fetch_history
from .news import NewsError, fetch_news
from .quotes import QuoteError, fetch_quotes
from .webfetch import FetchError, fetch_article_text
from .webz import WebzError, fetch_geo_news
from langchain_core.tools import tool


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


def run_geo_news_tool(query, limit=5):
    """Fetch world/geopolitical news and render it as tool-result text;
    also return the GeoArticles."""
    try:
        articles = fetch_geo_news(query, limit=limit)
    except WebzError as e:
        return "error: %s" % e, []

    if not articles:
        return "no relevant world news found", []

    blocks = [
        "date: %s\ncountry: %s\nsentiment: %s\ntitle: %s\nurl: %s\nsummary: %s" % (
            (a.date or "")[:10], a.country or "?", a.sentiment or "?", a.title, a.link, a.summary,
        )
        for a in articles
    ]
    return "\n---\n".join(blocks), articles


@tool
def get_geopolitical_news(query: str, limit: int = 5) -> str:
    """Search world/general news (via webz.io) for geopolitical or macro
    developments -- tariffs, sanctions, export controls, elections,
    central-bank decisions, regional conflicts, commodity shocks -- that
    aren't scoped to one ticker the way get_stock_news is.

    `query` is free text describing the situation, not a ticker symbol
    (e.g. "Taiwan semiconductor export controls", "Red Sea shipping
    disruption", "Fed interest rate decision"). Use this to find outside
    forces that could move a stock beyond its own company-specific news --
    think about what countries, supply chains, or commodities a company is
    exposed to, and search creatively for developments there.
    """
    text, _ = run_geo_news_tool(query, limit=limit)
    return text


UNKNOWN_ARTICLE_URL_ERROR = (
    "error: url must be one get_stock_news or get_geopolitical_news "
    "returned in this conversation"
)


def run_read_article_tool(url):
    """Fetch and extract an article's full readable text as tool-result text."""
    try:
        return fetch_article_text(url)
    except FetchError as e:
        return "error: %s" % e


@tool
def read_article(url: str) -> str:
    """Read the full text of one news article, given its exact url.

    Only call this with a url that get_stock_news or get_geopolitical_news
    already returned in this conversation -- use it when that article's
    short summary doesn't cover what the question needs.
    """
    return run_read_article_tool(url)
