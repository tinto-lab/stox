"""The REPL: reads input, routes it, owns the Console, prints results.

The only module that imports rich for interaction (rendering.py takes a
Console as a parameter instead of owning one) and the only place that
decides whether a line is a ticker list or a natural-language question.
"""

import atexit
import os
import re

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from . import agent, providers
from .config import CONFIG_DIR, load_env
from .considerations import CONSIDERATIONS_FILE, load_considerations
from .quotes import QuoteError, api_key, fetch_quotes, normalize
from .rendering import show_news, show_quote, show_quotes_compact

try:
    import readline
except ImportError:
    readline = None

console = Console()

HISTORY_FILE = CONFIG_DIR / "history"

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*m")


def _prompt_string(markup_text: str) -> str:
    """Render Rich markup to a raw-ANSI string safe to use as a readline prompt.

    Readline (GNU readline and macOS's libedit both) needs to know which
    bytes in the prompt are invisible color codes so it can compute the
    prompt's true on-screen width. Without that bracketing, its cursor
    math is wrong for the *entire* line, not just at the prompt boundary:
    a word-delete can eat into the prompt text, and after jumping to the
    start of the line the cursor can't reliably find its way back to the
    true end. The fix is the documented readline convention: wrap each
    invisible escape sequence in \\001 (RL_PROMPT_START_IGNORE) / \\002
    (RL_PROMPT_END_IGNORE).
    """
    with console.capture() as capture:
        console.print(markup_text, end="")
    rendered = capture.get()
    return _ANSI_ESCAPE_RE.sub(lambda m: "\001" + m.group(0) + "\002", rendered)


PROMPT = _prompt_string("[bold cyan]›[/] ")

BANNER = ("[bold]stox[/] · research console\n"
          "[dim]type tickers (AAPL — or TSLA MSFT NVDA) or ask a question "
          "· /help · /quit[/]")

HELP = """[bold]commands[/]
  <ticker> [...]   fetch quote(s):  AAPL   or   TSLA MSFT NVDA
  <question>       ask in plain English:  what's apple trading at today?
                                           any news on tesla?
                                           always factor in insider selling
                                           when you explain price moves
                                           the agent remembers this session --
                                           follow-ups like "what about its news?"
                                           and "read that first one in full" work
  /help            this message
  /clear           clear the screen
  /reset           forget the conversation so far (also /new)
  /considerations  list standing factors the agent always weighs (also /remembered)
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
    ANTHROPIC_API_KEY=...  or DEEPSEEK_API_KEY / OPENAI_API_KEY

  standing considerations persist to ~/.config/stox/considerations.txt --
  plain text, one per line, safe to hand-edit or delete."""

_QUERY_HINTS = {
    "what", "whats", "what's", "is", "are", "the", "of", "how", "much",
    "price", "stock", "shares", "today", "tell", "me", "show", "give",
    "about", "does", "do", "doing", "trading", "worth", "current", "for",
    "news", "headline", "headlines", "latest", "recent", "happening",
    "update", "updates",
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


def _show_considerations():
    """List standing considerations stored on disk (see /reset for
    session-only conversation memory, which this is not)."""
    items = load_considerations()
    if not items:
        console.print("[dim]no standing considerations yet -- tell the agent "
                       "to always factor something in, or edit %s "
                       "directly.[/]" % CONSIDERATIONS_FILE)
        return
    console.print("[dim]standing considerations (%s):[/]" % CONSIDERATIONS_FILE)
    for item in items:
        console.print(Text("  - " + item))


def handle_command(cmd, history):
    cmd = cmd.lower()
    if cmd in ("/quit", "/exit", "/q"):
        console.print("[dim]bye.[/]")
        return False
    if cmd == "/help":
        console.print(Panel(HELP, border_style="dim", expand=False))
    elif cmd == "/clear":
        console.clear()
        console.print(Panel(BANNER, border_style="cyan", expand=False))
    elif cmd in ("/reset", "/new"):
        history.clear()
        console.print("[dim]conversation forgotten -- starting fresh.[/]")
    elif cmd in ("/considerations", "/remembered"):
        _show_considerations()
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


def _print_tool_call(name, args):
    """Called by ask_agent right before each tool runs, for visibility into
    what the model is doing (e.g. "did it actually fetch news, or just
    answer from memory?"). Wrapped in Text() rather than markup -- args
    ultimately trace back through the model, which may have ingested
    external content (an article's text), so treat them as untrusted.
    """
    params = ", ".join("%s=%r" % (k, v) for k, v in args.items())
    console.print(Text("  ↳ %s(%s)" % (name, params), style="dim"))


def handle_query(text, history):
    """The natural-language path: hand off to the agent, then render its result.

    `history` carries prior turns' messages so follow-ups like "what about
    its news?" resolve; ask_agent updates it in place.
    """
    console.print("[dim]→ agent (%s) · %s[/]" % (providers.describe_current(), text))
    result = agent.ask_agent(text, history=history, on_tool_call=_print_tool_call)

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

    if result.articles:
        show_news(console, result.articles)


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

    history = []

    while True:
        try:
            line = input(PROMPT).strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[dim]bye.[/]")
            break
        if not line:
            continue
        if line.startswith("/"):
            if not handle_command(line, history):
                break
        elif _looks_like_query(line):
            handle_query(line, history)
        else:
            handle_tickers(line)
