"""Yahoo Finance (via yfinance) data source: fetch and parse company
fundamentals.

The odd one out among quotes/news/history/fundamentals: those three are
all EODHD, but EODHD's fundamentals endpoint needs a paid plan (a real
free-tier EODHD key gets "access denied" on it -- only their shared demo
key, and only for its handful of demo tickers, gets through for free). This
module goes through yfinance instead: free and keyless, but unofficial --
it reads Yahoo Finance's own endpoints rather than a published API, so it
can change or break without notice and has no documented rate limit or SLA.
"""

import yfinance as yf


class Fundamentals:
    def __init__(self, code, name, sector, industry, market_cap, pe_ratio,
                 peg_ratio, profit_margin, operating_margin, roe, roa,
                 ebitda, revenue_ttm, revenue_growth_yoy, earnings_growth_yoy,
                 eps, dividend_yield, analyst_target_price):
        self.code = code
        self.name = name
        self.sector = sector
        self.industry = industry
        self.market_cap = market_cap
        self.pe_ratio = pe_ratio
        self.peg_ratio = peg_ratio
        self.profit_margin = profit_margin
        self.operating_margin = operating_margin
        self.roe = roe
        self.roa = roa
        self.ebitda = ebitda
        self.revenue_ttm = revenue_ttm
        self.revenue_growth_yoy = revenue_growth_yoy
        self.earnings_growth_yoy = earnings_growth_yoy
        self.eps = eps
        self.dividend_yield = dividend_yield
        self.analyst_target_price = analyst_target_price

    def __eq__(self, other):
        return isinstance(other, Fundamentals) and self.__dict__ == other.__dict__

    def __repr__(self):
        return "Fundamentals(%r)" % (self.__dict__,)


class FundamentalsError(Exception):
    """Raised when fundamentals can't be fetched at all (network/lookup failure)."""


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _yahoo_symbol(ticker):
    """Yahoo Finance tickers don't take EODHD's SYMBOL.EXCHANGE convention
    -- strip a ".US" (what quotes.normalize would add for a bare symbol),
    but leave any other suffix alone since that's the caller naming an
    actual non-US exchange, which is on Yahoo's own terms, not EODHD's."""
    t = ticker.upper()
    return t[:-3] if t.endswith(".US") else t


def _parse(code, info: dict):
    name = info.get("longName") or info.get("shortName")
    if not name:
        return None

    dividend_yield = _num(info.get("dividendYield"))
    if dividend_yield is not None:
        dividend_yield /= 100  # yfinance reports this in percentage points, not a fraction

    peg_ratio = info.get("trailingPegRatio")
    if peg_ratio is None:
        peg_ratio = info.get("pegRatio")

    return Fundamentals(
        code=info.get("symbol") or code,
        name=name,
        sector=info.get("sector") or "",
        industry=info.get("industry") or "",
        market_cap=_num(info.get("marketCap")),
        pe_ratio=_num(info.get("trailingPE")),
        peg_ratio=_num(peg_ratio),
        profit_margin=_num(info.get("profitMargins")),
        operating_margin=_num(info.get("operatingMargins")),
        roe=_num(info.get("returnOnEquity")),
        roa=_num(info.get("returnOnAssets")),
        ebitda=_num(info.get("ebitda")),
        revenue_ttm=_num(info.get("totalRevenue")),
        revenue_growth_yoy=_num(info.get("revenueGrowth")),
        earnings_growth_yoy=_num(info.get("earningsGrowth")),
        eps=_num(info.get("trailingEps")),
        dividend_yield=dividend_yield,
        analyst_target_price=_num(info.get("targetMeanPrice")),
    )


def fetch_fundamentals(ticker):
    """Return profitability/valuation metrics for one ticker via Yahoo Finance.

    Raises FundamentalsError on failure, including an unknown symbol (an
    unrecognized ticker just comes back from yfinance with no longName/
    shortName, which we treat as not found).
    """
    code = _yahoo_symbol(ticker)
    try:
        info = yf.Ticker(code).info
    except Exception as e:
        # yfinance is unofficial and doesn't consistently raise one
        # exception family (network errors, its own YFException subclasses,
        # and Yahoo-side HTML/JSON changes have all been seen) -- caught
        # broadly and reported the same way as any other fetch failure.
        raise FundamentalsError("couldn't fetch fundamentals: %s" % e) from e

    if not isinstance(info, dict):
        raise FundamentalsError("couldn't parse response")

    fundamentals = _parse(code, info)
    if fundamentals is None:
        raise FundamentalsError("no fundamentals data (unknown symbol?)")
    return fundamentals
