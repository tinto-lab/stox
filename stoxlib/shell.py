"""The REPL: reads input, routes it, owns the Console, prints results.

The only module that imports rich for interaction (rendering.py takes a
Console as a parameter instead of owning one). Routing here is
deliberately trivial: a slash command is handled locally, and everything
else goes to the agent, which decides what the user actually needs (a
price only, or news/history/fundamentals/a full risk analysis too) --
that used to be guessed locally with English keyword heuristics, which
broke for anything not phrased in English. /price is the one local
shortcut left, for an instant, LLM-free quote lookup.
"""

import atexit
import os
import re
import threading

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from . import agent, providers
from .analysis import run_stock_analysis
from .config import CONFIG_DIR, load_env
from .considerations import CONSIDERATIONS_FILE, load_considerations
from .quotes import QuoteError, api_key, fetch_quotes, normalize
from .rendering import (show_analysis, show_fundamentals, show_news,
                         show_price_history, show_quote, show_quotes_compact)

try:
    import readline
except ImportError:
    readline = None

console = Console()

# run_stock_analysis runs its three specialists concurrently in separate
# threads (see analysis.py), and Console.print isn't guaranteed safe against
# unmanaged concurrent writes from multiple threads -- every print that can
# happen from one of those threads (a specialist's tool-call callback) goes
# through this lock so lines from different specialists don't interleave
# mid-line. Printing from the main thread (everything else) doesn't need it,
# but taking an uncontended lock is cheap, so _print_tool_call holds it too
# rather than having two similar-looking print paths, only one of which locks.
_console_lock = threading.Lock()

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
          "[dim]ask about a stock, in any language -- or /price AAPL for "
          "an instant quote · /help · /quit[/]")

HELP = """[bold]commands[/]
  <anything>       ask about a stock, in any language -- the agent decides
                    what you actually need:
                      AAPL  or  what's apple trading at?   -> just the price
                      any news on tesla?                   -> price + news
                      how has tesla done this month?       -> price history
                      should I buy apple? / assess the risk -> full /analyze
                    the agent remembers this session -- follow-ups like
                    "what about its news?" and "read that first one in
                    full" work; always factor in insider selling when you
                    explain price moves also works, to save a standing note
  /price <ticker> [...]  instant quote(s), no LLM involved:
                          AAPL   or   TSLA MSFT NVDA
  /analyze <ticker>  run trend, fundamentals, and news specialist agents for
                     one ticker, then an aggregator's risk assessment --
                     4 LLM calls, slower than a plain question
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
  or a free key from eodhd.com (20 calls/day). Powers quotes, news, and
  price history. Fundamentals (EBITDA, margins, ...) are separate -- via
  Yahoo Finance, free and keyless, no setup needed.

  everything except /price needs an LLM provider:
    STOX_LLM_PROVIDER=anthropic|deepseek|openai  (default: anthropic)
    STOX_LLM_MODEL=...     optional, each provider has a default
    ANTHROPIC_API_KEY=...  or DEEPSEEK_API_KEY / OPENAI_API_KEY

  standing considerations persist to ~/.config/stox/considerations.txt --
  plain text, one per line, safe to hand-edit or delete."""


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
    word, _, rest = cmd.partition(" ")
    word = word.lower()
    if word in ("/quit", "/exit", "/q"):
        console.print("[dim]bye.[/]")
        return False
    if word == "/help":
        console.print(Panel(HELP, border_style="dim", expand=False))
    elif word == "/clear":
        console.clear()
        console.print(Panel(BANNER, border_style="cyan", expand=False))
    elif word in ("/reset", "/new"):
        history.clear()
        console.print("[dim]conversation forgotten -- starting fresh.[/]")
    elif word in ("/considerations", "/remembered"):
        _show_considerations()
    elif word == "/analyze":
        ticker = rest.strip().split()[:1]
        if not ticker:
            console.print("[red]usage:[/] /analyze <ticker>")
        else:
            handle_analyze(ticker[0])
    elif word == "/price":
        if not rest.strip():
            console.print("[red]usage:[/] /price <ticker> [...]")
        else:
            handle_tickers(rest)
    else:
        console.print("[red]unknown command:[/] %s  [dim](try /help)[/]" % word)
    return True


def handle_tickers(text):
    """The /price command: text is a bare ticker list, fetch and show it
    directly -- no LLM involved."""
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
    with _console_lock:
        console.print(Text("  ↳ %s(%s)" % (name, params), style="dim"))


def _print_analysis_tool_call(agent_name, name, args):
    """Called by run_stock_analysis, from whichever of the three specialist
    threads makes a tool call -- the counterpart to _print_tool_call, with
    an extra leading agent_name (see run_stock_analysis's on_tool_call
    docstring) so concurrent, interleaved tool calls from different
    specialists are still attributable to the one that made each call."""
    params = ", ".join("%s=%r" % (k, v) for k, v in args.items())
    with _console_lock:
        console.print(Text("  ↳ [%s] %s(%s)" % (agent_name, name, params), style="dim"))


def _show_result_data(quotes, bars, fundamentals, articles):
    """Render whatever a quote/history/fundamentals/news fetch came back
    with. Shared by handle_query (an AgentResult) and handle_analyze (an
    AnalysisResult) -- both carry these same four fields, just as
    different result types, so this takes the values directly rather than
    one object of either type."""
    if len(quotes) == 1:
        show_quote(console, quotes[0])
    elif quotes:
        show_quotes_compact(console, quotes)

    if bars:
        show_price_history(console, bars)

    if fundamentals:
        show_fundamentals(console, fundamentals)

    if articles:
        show_news(console, articles)


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
    _show_result_data(result.quotes, result.bars, result.fundamentals, result.articles)

    if result.analysis:
        show_analysis(console, result.analysis)


def _print_agent_start(name):
    """Called by run_stock_analysis for visibility into which stage a slow
    multi-agent run is on: trend/fundamentals/news fire together right
    before they're kicked off concurrently, then aggregator fires once all
    three are back (see run_stock_analysis's on_agent_start docstring)."""
    console.print(Text("→ %s agent" % name, style="dim"))


def handle_analyze(ticker):
    """The /analyze command: run the full trend/fundamentals/news pipeline
    and the aggregator's risk assessment for one ticker directly, without
    going through the general chat agent."""
    console.print("[dim]→ analyzing %s · trend, fundamentals, and news run "
                   "concurrently, then an aggregator · 4 LLM calls, please "
                   "wait[/]" % normalize(ticker))
    result = run_stock_analysis(ticker, on_agent_start=_print_agent_start,
                                 on_tool_call=_print_analysis_tool_call)

    if result.error:
        console.print("[red]✗[/] %s" % result.error)
        return

    console.print()
    _show_result_data(result.quotes, result.bars, result.fundamentals, result.articles)
    show_analysis(console, result)


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
        else:
            handle_query(line, history)
