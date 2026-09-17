"""Presentation: turn Quote objects into rich console output.

Takes a Console explicitly instead of owning one, so nothing here is tied
to a particular Console instance -- shell.py owns that.
"""

from rich.console import Console
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
