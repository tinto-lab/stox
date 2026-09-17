"""The REPL: reads input, routes it, owns the Console, prints results.

The only module that imports rich for interaction (rendering.py takes a
Console as a parameter instead of owning one) and the only place that
decides whether a line is a ticker list or a natural-language question.
"""

import atexit
import os

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from . import agent, providers
from .config import CONFIG_DIR, load_env
from .quotes import QuoteError, api_key, fetch_quotes, normalize
from .rendering import show_quote, show_quotes_compact

try:
    import readline
except ImportError:
    readline = None

console = Console()

HISTORY_FILE = CONFIG_DIR / "history"

BANNER = ("[bold]stox[/] · research console\n"
          "[dim]type tickers (AAPL — or TSLA MSFT NVDA) or ask a question "
          "· /help · /quit[/]")

HELP = """[bold]commands[/]
  <ticker> [...]   fetch quote(s):  AAPL   or   TSLA MSFT NVDA
  <question>       ask in plain English:  what's apple trading at today?
  /help            this message
  /clear           clear the screen
  /quit  /exit     leave

[bold]tickers[/]
  bare symbols default to .US (AAPL -> AAPL.US)
  add the exchange for anything else:
    BMW.XETRA   BTC-USD.CC   EURUSD.FOREX

[bold]setup[/]
  keys can go in a .env file instead of export -- see .env.example.
  checked at startup: ~/.config/stox/.env, then ./.env (project-local wins).

  EODHD_API_KEY=demo   -> test AAPL.US TSLA.US VTI.US
                          AMZN.US BTC-USD.CC EURUSD.FOREX
  or a free key from eodhd.com (20 calls/day).

  plain-English questions need an LLM provider:
    STOX_LLM_PROVIDER=anthropic|deepseek|openai  (default: anthropic)
    STOX_LLM_MODEL=...     optional, each provider has a default
    ANTHROPIC_API_KEY=...  or DEEPSEEK_API_KEY / OPENAI_API_KEY"""

_QUERY_HINTS = {
    "what", "whats", "what's", "is", "are", "the", "of", "how", "much",
    "price", "stock", "shares", "today", "tell", "me", "show", "give",
    "about", "does", "do", "doing", "trading", "worth", "current", "for",
}


def _looks_like_query(text):
    """True for natural-language questions; false for a bare ticker list."""
    if "?" in text:
        return True
    words = text.lower().split()
    return any(w.strip(".,!") in _QUERY_HINTS for w in words)


def _setup_readline():
    """Enable proper line editing (arrow keys, backspace, word-jump) and
    persistent history for the `>` prompt.

    console.input() delegates to the builtin input(), which only gets
    real line editing once the readline module has been imported -- that's
    the actual fix for the left-arrow-does-nothing problem. Everything
    below that is a bonus on top: Option/Alt+Left/Right already jumps by
    word by default once readline is active; the explicit bindings add
    Ctrl+Left/Right and Shift+Left/Right for terminals that use those
    instead.
    """
    if readline is None:
        return  # no readline available in this Python build -- degrade quietly

    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        readline.read_history_file(HISTORY_FILE)
    except OSError:
        pass  # no history yet
    readline.set_history_length(1000)
    atexit.register(readline.write_history_file, HISTORY_FILE)

    is_libedit = "libedit" in (readline.__doc__ or "")
    forward_word = "em-next-word" if is_libedit else "forward-word"
    backward_word = "ed-prev-word" if is_libedit else "backward-word"
    bind_prefix = "bind " if is_libedit else ""
    bindings = [
        (r"\e[1;5C", forward_word),   # ctrl+right
        (r"\e[1;5D", backward_word),  # ctrl+left
        (r"\e[1;2C", forward_word),   # shift+right
        (r"\e[1;2D", backward_word),  # shift+left
    ]
    for keyseq, func in bindings:
        try:
            if is_libedit:
                readline.parse_and_bind('%s"%s" %s' % (bind_prefix, keyseq, func))
            else:
                readline.parse_and_bind('"%s": %s' % (keyseq, func))
        except Exception:
            pass  # best-effort -- terminal/readline combo may not agree


def handle_command(cmd):
    cmd = cmd.lower()
    if cmd in ("/quit", "/exit", "/q"):
        console.print("[dim]bye.[/]")
        return False
    if cmd == "/help":
        console.print(Panel(HELP, border_style="dim", expand=False))
    elif cmd == "/clear":
        console.clear()
        console.print(Panel(BANNER, border_style="cyan", expand=False))
    else:
        console.print("[red]unknown command:[/] %s  [dim](try /help)[/]" % cmd)
    return True


def handle_tickers(text):
    """The direct path: text is a bare ticker list, fetch and show it."""
    tickers = text.split()
    console.print("[dim]→ quote · %s[/]" % ", ".join(normalize(t) for t in tickers))

    try:
        quotes, missing = fetch_quotes(tickers)
    except QuoteError as e:
        console.print("[red]✗[/] %s" % e)
        return

    for code in missing:
        console.print("[red]✗ %s:[/] no data (unknown symbol?)" % code)

    if len(quotes) == 1:
        show_quote(console, quotes[0])
    elif quotes:
        show_quotes_compact(console, quotes)


def handle_query(text):
    """The natural-language path: hand off to the agent, then render its result."""
    console.print("[dim]→ agent (%s) · %s[/]" % (providers.describe_current(), text))
    result = agent.ask_agent(text)

    if result.error:
        console.print("[red]✗[/] %s" % result.error)
        return

    if result.text:
        console.print(Text(result.text))

    console.print()
    if len(result.quotes) == 1:
        show_quote(console, result.quotes[0])
    elif result.quotes:
        show_quotes_compact(console, result.quotes)


def main():
    load_env()
    _setup_readline()

    console.print(Panel(BANNER, border_style="cyan", expand=False))
    if not api_key():
        console.print("[yellow]![/] no EODHD_API_KEY set -- see [bold]/help[/].\n")

    provider = providers.current_provider_name()
    key_env = providers.LLM_PROVIDERS.get(provider, {}).get("api_key_env")
    if not key_env or not os.environ.get(key_env):
        console.print("[yellow]![/] no LLM provider configured -- plain-English "
                       "questions won't work -- see [bold]/help[/].\n")
    else:
        console.print("[dim]LLM provider: %s[/]\n" % providers.describe_current())

    while True:
        try:
            line = console.input("[bold cyan]›[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]bye.[/]")
            break
        if not line:
            continue
        if line.startswith("/"):
            if not handle_command(line):
                break
        elif _looks_like_query(line):
            handle_query(line)
        else:
            handle_tickers(line)
