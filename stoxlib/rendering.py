"""Presentation: turn Quote and Article objects into rich console output.

Takes a Console explicitly instead of owning one, so nothing here is tied
to a particular Console instance -- shell.py owns that.
"""

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text


def _arrow_color(change):
    if change > 0:
        return "▲", "green"
    if change < 0:
        return "▼", "red"
    return "•", "white"


def _fmt_vol(v):
    for unit, div in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if v >= div:
            return "%.1f%s" % (v / div, unit)
    return "%.0f" % v


def show_quote(console: Console, q):
    """Detailed block for a single ticker."""
    arrow, color = _arrow_color(q.change)
    base, _, ex = q.code.rpartition(".")
    base = base or q.code

    header = Table.grid(expand=True)
    header.add_column(justify="left")
    header.add_column(justify="right")
    header.add_row("[bold]%s[/]" % base, "[dim]%s[/]" % ex)
    console.print(header)

    line = Text()
    line.append(format(q.price, ",.2f"), style="bold")
    line.append("   ")
    line.append("%s %+.2f  (%+.2f%%)" % (arrow, q.change, q.percent), style=color)
    console.print(line)
    console.print("[dim]" + "─" * 44 + "[/]")

    stats = Table.grid(padding=(0, 4))
    stats.add_column()
    stats.add_column()
    stats.add_row("[dim]open  [/] %s" % format(q.open, ",.2f"),
                  "[dim]volume[/] %s" % _fmt_vol(q.volume))
    stats.add_row("[dim]range [/] %s – %s" % (format(q.low, ",.2f"), format(q.high, ",.2f")),
                  "[dim]prev  [/] %s" % format(q.prev_close, ",.2f"))
    console.print(stats)
    console.print()


def show_quotes_compact(console: Console, quotes):
    """One row per ticker for a multi-ticker request."""
    table = Table(show_header=False, box=None, padding=(0, 2))
    for q in quotes:
        arrow, color = _arrow_color(q.change)
        table.add_row(
            "[bold]%s[/]" % q.code,
            format(q.price, ",.2f"),
            "[%s]%s %+.2f[/]" % (color, arrow, q.change),
            "[%s](%+.2f%%)[/]" % (color, q.percent),
        )
    console.print(table)
    console.print()


def show_price_history(console: Console, bars):
    """Table of OHLC bars for one ticker, oldest first."""
    if not bars:
        console.print("[dim]no historical data[/]")
        console.print()
        return

    table = Table(title=bars[0].code, show_header=True, header_style="dim",
                   box=None, padding=(0, 2))
    table.add_column("date")
    table.add_column("open", justify="right")
    table.add_column("high", justify="right")
    table.add_column("low", justify="right")
    table.add_column("close", justify="right")
    table.add_column("volume", justify="right")

    prev_close = None
    for b in bars:
        change = 0.0 if prev_close is None else b.close - prev_close
        arrow, color = _arrow_color(change)
        table.add_row(
            b.date[:10],
            format(b.open, ",.2f"),
            format(b.high, ",.2f"),
            format(b.low, ",.2f"),
            "[%s]%s %s[/]" % (color, arrow, format(b.close, ",.2f")),
            _fmt_vol(b.volume),
        )
        prev_close = b.close
    console.print(table)
    console.print()


def _fmt_pct(v):
    return "%+.2f%%" % (v * 100) if v is not None else "n/a"


def _fmt_money(v):
    return _fmt_vol(v) if v is not None else "n/a"


def _fmt_ratio(v):
    return format(v, ",.2f") if v is not None else "n/a"


def show_fundamentals(console: Console, f):
    """Detailed profitability/valuation block for a single ticker."""
    header = Table.grid(expand=True)
    header.add_column(justify="left")
    header.add_column(justify="right")
    header.add_row("[bold]%s[/]  [dim]%s[/]" % (f.code, f.name),
                    "[dim]%s · %s[/]" % (f.sector, f.industry))
    console.print(header)
    console.print("[dim]" + "─" * 44 + "[/]")

    stats = Table.grid(padding=(0, 4))
    stats.add_column()
    stats.add_column()
    stats.add_row("[dim]market cap[/] %s" % _fmt_money(f.market_cap),
                  "[dim]ebitda[/] %s" % _fmt_money(f.ebitda))
    stats.add_row("[dim]revenue ttm[/] %s" % _fmt_money(f.revenue_ttm),
                  "[dim]eps[/] %s" % _fmt_ratio(f.eps))
    stats.add_row("[dim]profit margin[/] %s" % _fmt_pct(f.profit_margin),
                  "[dim]operating margin[/] %s" % _fmt_pct(f.operating_margin))
    stats.add_row("[dim]roe[/] %s" % _fmt_pct(f.roe),
                  "[dim]roa[/] %s" % _fmt_pct(f.roa))
    stats.add_row("[dim]revenue growth yoy[/] %s" % _fmt_pct(f.revenue_growth_yoy),
                  "[dim]earnings growth yoy[/] %s" % _fmt_pct(f.earnings_growth_yoy))
    stats.add_row("[dim]p/e[/] %s" % _fmt_ratio(f.pe_ratio),
                  "[dim]peg[/] %s" % _fmt_ratio(f.peg_ratio))
    stats.add_row("[dim]dividend yield[/] %s" % _fmt_pct(f.dividend_yield),
                  "[dim]analyst target[/] %s" % _fmt_ratio(f.analyst_target_price))
    console.print(stats)
    console.print()


def show_analysis(console: Console, result):
    """The four specialist write-ups plus the aggregator's risk
    assessment, for an analysis.AnalysisResult.

    Each panel's text ultimately comes from the LLM, which may have
    ingested external content (an article's text) -- wrapped in Text()
    rather than markup so it can never be parsed as a Rich style tag.
    """
    panels = [
        (result.trend_text, "trend", "dim"),
        (result.fundamentals_text, "fundamentals", "dim"),
        (result.news_text, "news", "dim"),
        (result.geopolitics_text, "geopolitics", "dim"),
        (result.verdict_text, "risk assessment", "yellow"),
    ]
    for text, title, border_style in panels:
        console.print(Panel(Text(text), title=title, border_style=border_style, expand=False))
    console.print("[dim]not financial advice -- for research purposes only.[/]")
    console.print()


def _sentiment_arrow(sentiment):
    polarity = (sentiment or {}).get("polarity")
    if not isinstance(polarity, (int, float)):
        return "•", "white"
    if polarity > 0.1:
        return "▲", "green"
    if polarity < -0.1:
        return "▼", "red"
    return "•", "white"


def show_news(console: Console, articles):
    """Headline list: date, sentiment arrow, title, and link.

    Titles and links come from an external source, so they're wrapped in
    Text() rather than interpolated into a markup string -- that way a
    stray '[' in a headline can never be parsed as a Rich style tag.
    """
    if not articles:
        console.print("[dim]no recent news[/]")
        console.print()
        return

    table = Table(show_header=False, box=None, padding=(0, 1))
    for a in articles:
        arrow, color = _sentiment_arrow(a.sentiment)
        date = (a.date or "")[:10]
        table.add_row("[dim]%s[/]" % date, "[%s]%s[/]" % (color, arrow), Text(a.title, style="bold"))
        table.add_row("", "", Text(a.link, style="dim"))
    console.print(table)
    console.print()


def _geo_sentiment_arrow(sentiment):
    """Like _sentiment_arrow, but for GeoArticle's plain positive/negative/
    neutral string instead of EODHD's {"polarity": float} dict. Google
    News articles carry no sentiment, so they get the neutral dot."""
    s = (sentiment or "").strip().lower()
    if s == "positive":
        return "▲", "green"
    if s == "negative":
        return "▼", "red"
    return "•", "white"


def show_geo_news(console: Console, articles):
    """Headline list for world/geopolitical news (Google News): date, country,
    sentiment arrow, title, and link -- the counterpart to show_news for
    GeoArticle instead of Article.

    Titles and links come from an external source, so they're wrapped in
    Text() rather than interpolated into a markup string, same reasoning
    as show_news.
    """
    if not articles:
        console.print("[dim]no relevant world news[/]")
        console.print()
        return

    table = Table(show_header=False, box=None, padding=(0, 1))
    for a in articles:
        arrow, color = _geo_sentiment_arrow(a.sentiment)
        date = (a.date or "")[:10]
        table.add_row("[dim]%s[/]" % date, "[dim]%s[/]" % (a.country or "?"),
                      "[%s]%s[/]" % (color, arrow), Text(a.title, style="bold"))
        table.add_row("", "", "", Text(a.link, style="dim"))
    console.print(table)
    console.print()
