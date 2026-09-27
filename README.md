# stox

A tiny terminal console for looking up stock, ETF, crypto, and FX prices —
plus recent financial news — with a natural-language research mode backed
by a swappable LLM provider (Anthropic, DeepSeek, OpenAI-compatible, ...).

There are two frontends: the terminal REPL (`stox.py`, below) and a native
macOS app (`macapp/`, see [macOS app](#macos-app)). The app is a stock
price and fundamentals dashboard that calls the data APIs itself, with the
REPL's research chat available as an optional side panel on the same
Python backend.

## Layout

```
stox.py                terminal entry point (`python stox.py`)
stox_bridge.py          JSON-lines entry point for the macOS app (`python stox_bridge.py`)
stoxlib/
  quotes.py            EODHD quotes data source — Quote, fetch_quotes
  news.py              EODHD news data source — Article, fetch_news
  gnews.py             Google News RSS world/geopolitical news (free, keyless) — GeoArticle, fetch_geo_news
  webfetch.py          fetches a url and extracts its readable article text
  fundamentals.py      company fundamentals (yfinance) — Fundamentals, fetch_fundamentals
  history.py           OHLC price history — Bar, fetch_history
  considerations.py    standing factors the agent always weighs, persisted to disk
  rendering.py         Quote/Article -> rich console output (terminal only)
  providers.py         LLM provider registry (STOX_LLM_PROVIDER -> chat model)
  tool_loop.py          shared LLM tool-calling loop used by agent.py and analysis.py
  tools.py              the individual tool implementations (quote/news/history/...)
  agent.py             natural-language question handling (LangChain tool use)
  analysis.py           the /analyze multi-agent trend/fundamentals/news/geopolitics pipeline
  config.py             loads .env files so keys don't need `export`ing every time
  shell.py              the terminal REPL — routes input, owns the Console, line editing
  bridge.py              the JSON-lines protocol behind stox_bridge.py, for the macOS app
macapp/                 the native macOS app (Electron + TypeScript/React) — see below
packaging/stox-backend.spec  PyInstaller build spec, bundles stox_bridge.py for the packaged app
scripts/build_backend.sh     builds that spec and drops the result in macapp/backend/
tests/                 pytest suite, one file per stoxlib module (see Testing)
requirements.txt       pinned runtime dependencies
requirements-dev.txt   requirements.txt + pytest
requirements-build.txt requirements.txt + pyinstaller, only for scripts/build_backend.sh
```

Each module has one job; see `stoxlib/__init__.py` for the short version.

## Requirements

- Python (managed here via pyenv)
- An EODHD API key — the free `demo` key works for testing, no signup
- For plain-English questions: an API key for whichever LLM provider you pick

## Setup

From the project folder (wherever `stox.py` lives):

```bash
# optional: pin the Python version for this project first
pyenv local 3.12

python -m venv .venv          # create the virtual environment (one time)
source .venv/bin/activate     # activate it (each new terminal session)
pip install -r requirements.txt        # just to run it
pip install -r requirements-dev.txt    # to also run the test suite
```

You'll know the venv is active when your prompt shows `(.venv)` and
`which python` points at `.venv/bin/python`. Run `deactivate` to leave it.

`requirements.txt` covers all three LLM providers (Anthropic, DeepSeek,
OpenAI) so nothing extra needs installing no matter which `STOX_LLM_PROVIDER`
you pick — only the one you actually use gets imported at runtime.

## Running it

### Option A: a .env file (recommended — set once, no more `export`ing)

```bash
cp .env.example .env      # project-local; or ~/.config/stox/.env for all projects
$EDITOR .env               # fill in the keys you need
python stox.py
```

Both files are loaded automatically on startup (project `.env` overrides the
`~/.config/stox/.env` one; a real `export`ed env var always wins over either).
`.env` is git-ignored — never commit it.

### Option B: export in your shell

```bash
export EODHD_API_KEY=demo      # test key — see supported tickers below
python stox.py
```

Swap `demo` for your own free key from https://eodhd.com once the wiring
checks out.

For plain-English questions, also set an LLM provider (defaults to
`anthropic` if unset):

```bash
export STOX_LLM_PROVIDER=deepseek     # anthropic | deepseek | openai
export STOX_LLM_MODEL=deepseek-chat   # optional, each provider has a default
export DEEPSEEK_API_KEY=...           # whichever provider you picked
```

### Line editing

The prompt supports normal terminal line editing: left/right arrows, up/down
for history (persisted across sessions in `~/.config/stox/history`),
Ctrl+A/E for start/end of line, and word-jump via Option/Alt+Left/Right,
Ctrl+Left/Right, or Shift+Left/Right (whichever your terminal sends).

## Usage

Type one or more tickers, or a plain-English question, at the `›` prompt:

```
›  AAPL
›  TSLA MSFT NVDA                       # several at once = one API call
›  what's apple trading at today?       # routed to the agent, quote lookup
›  any news on tesla?                   # routed to the agent, news lookup
›  what about its news?                 # remembers "tesla" from the last question
›  what's going on with apple and how's it trading?   # agent can call both
```

Commands:

| command        | does                                                    |
|----------------|-----------------------------------------------------------|
| `<ticker> ...` | fetch quote(s)                                            |
| `<question>`   | ask in plain English — quotes, news, or both (needs an LLM key) |
| `/help`        | show help                                                  |
| `/clear`       | clear the screen                                           |
| `/reset`       | forget the conversation so far (also `/new`)               |
| `/considerations` | list standing factors the agent always weighs (also `/remembered`) |
| `/quit`        | leave (also `/exit`, Ctrl-D)                               |

News comes from EODHD too (same key as quotes), via the `get_stock_news`
tool the agent can call alongside `get_stock_quote` — it decides which
one(s) a question needs. `get_stock_news` only returns a short summary
of each article; when that's not enough (e.g. "what does the article say
about the deal terms?"), the agent can call a third tool, `read_article`,
to fetch and read one article's full text — but only for a url that
`get_stock_news` or `get_geopolitical_news` actually returned in that
conversation, never an arbitrary url, so the model can't direct stox to
fetch anything else.

For forces beyond one company — tariffs, sanctions, elections,
central-bank decisions, regional conflict — the agent can call
`get_geopolitical_news`, which searches general world news by free-text
query instead of a ticker — via Google News RSS (free, no key). `/analyze`
also runs a dedicated geopolitics specialist alongside trend/fundamentals/
news, folding whatever it finds into the aggregated risk assessment.

Every tool call the model actually makes is printed before its result, so
it's never a black box which of the three tools ran:

```
› any news on tesla?
→ agent (anthropic/claude-opus-5) · any news on tesla?
  ↳ get_stock_news(tickers=['TSLA'], limit=5)
Tesla has a couple of headlines today.
```

### Conversation memory

The agent remembers the current session: follow-ups like "what about its
news?" or "read that first one in full" resolve against earlier turns,
not just the latest question. History is kept in memory only (nothing is
written to disk) and is capped at the most recent 6 turns to bound token
cost, trimmed only at safe turn boundaries. Run `/reset` (or `/new`) to
start a clean conversation without restarting stox.

### Standing considerations (persist across sessions)

Separate from session memory, you can tell the agent to always factor
something in when it explains why a price is moving or assesses risk --
e.g. "always mention insider selling activity when a price drops," or
"factor in sector-wide trends, not just company news." The agent calls a
`remember_consideration` tool to save it to
`~/.config/stox/considerations.txt`, and every future session (not just
this one) automatically includes it in the agent's instructions. Run
`/considerations` (or `/remembered`) to see what's stored; the file is
plain text, one consideration per line, safe to hand-edit or delete.

### Ticker format

EODHD uses `SYMBOL.EXCHANGE`. A bare symbol defaults to `.US`:

| you type       | resolves to    |
|----------------|----------------|
| `AAPL`         | `AAPL.US`      |
| `BMW.XETRA`    | German listing |
| `BTC-USD.CC`   | crypto         |
| `EURUSD.FOREX` | FX             |

The `demo` key works only for: `AAPL.US`, `TSLA.US`, `VTI.US`, `AMZN.US`,
`BTC-USD.CC`, `EURUSD.FOREX`.

## macOS app

`macapp/` is a native macOS app (Electron + TypeScript/React) for checking
stock prices and company fundamentals:

- **Dashboard** — the tickers you've pinned, each with its live price, day
  change, day range, volume and a one-month sparkline. Prices refresh every
  minute. Pins are saved to `~/.config/stox/watchlist.json`.
- **Search** (⌘K) — look up a ticker or company name; Enter on a bare
  ticker (`AAPL`, `SHOP.TO`) opens it directly.
- **Stock view** — price chart (1M–5Y) with a hover crosshair, today's
  quote, and fundamentals: valuation, profitability, growth and cash flow,
  balance sheet, dividends and risk, analyst targets, and a company profile.
  Pin or unpin the stock from here.
- **Research chat** (⌘J) — an optional side panel with the same agent the
  terminal REPL has (plain-English questions, `/price`, `/analyze`, `/reset`,
  standing considerations). The stock view's "Analyze in chat" button runs
  `/analyze` there.

The dashboard, search and stock view don't use the Python backend at all:
the Electron main process (`macapp/src/main/marketData.ts`) calls the same
providers `stoxlib` uses directly — EODHD for quotes, history and symbol
search, and Yahoo Finance for fundamentals (no key needed). Yahoo requests
go through Electron's `net` module (Chromium's network stack), since Yahoo
rate-limits Node's own `fetch` on sight; that's the same reason yfinance
impersonates Chrome.

Only the chat panel uses `stoxlib`. It drives the backend through
`stox_bridge.py`, a JSON-lines process (one command in per line, one event
out per line — see `stoxlib/bridge.py`'s module docstring for the protocol)
that the main process spawns as a subprocess the first time the panel is
opened, not at launch.

### Running it (development)

Requires Node.js. The chat panel also needs the same Python setup as the
CLI (a `.venv` with `requirements.txt` installed), because the app's dev
mode spawns `.venv/bin/python3` directly:

```bash
cd macapp
npm install     # one time
npm run dev
```

The dashboard opens empty: search for a stock (⌘K), open it, and pin it.
Open the research chat with the Chat button or ⌘J. Settings (the EODHD key,
plus the chat's LLM provider/model and keys) are saved to
`~/.config/stox/.env`, the same file `config.load_env()` already reads, so
a key set from the app is immediately visible to the CLI too, and vice
versa. The dashboard only needs `EODHD_API_KEY`; the Python setup is only
needed for the chat panel.

`npm run typecheck` and `npm run build` (a one-off production build, output
to `macapp/out/`) are also available.

### Packaging a standalone `.app`

```bash
.venv/bin/pip install -r requirements-build.txt   # one time, adds pyinstaller
cd macapp
npm run relaunch     # kill any running instance, rebuild, sign, open the fresh build
```

`npm run relaunch` is the one-command dev loop: it runs `npm run stop`
(kills any Stox process still running — see below), `scripts/build_backend.sh`
(PyInstaller, via `packaging/stox-backend.spec`, freezing `stox_bridge.py`
and all of `stoxlib` into a standalone binary at `macapp/backend/stox-backend/`
— no system Python or this repo's `.venv` needed to run it), `electron-vite
build`, `electron-builder` (producing `macapp/dist/mac-arm64/Stox.app`),
an ad-hoc `codesign` (electron-builder's `identity: null` config skips
signing entirely; ad-hoc signing avoids a repeated Gatekeeper prompt on
every local launch — a paid Apple Developer ID + notarization would only
be needed to distribute the app to other people, out of scope for a
personal tool), then opens the result. Use `npm run package:mac` instead
if you don't want it to also open the app.

The three LangChain provider packages (`langchain_anthropic`/`_deepseek`/
`_openai`) are pulled in explicitly in the PyInstaller spec since
`providers.build_llm()` imports them by a runtime-built string
(`importlib.import_module`), which PyInstaller's static analysis can't
see on its own — see the spec's header comment.

**Stale running instances:** macOS apps keep running in the background
after their window is closed (only Cmd+Q, or killing the process,
actually stops them), and rebuilding the `.app` on disk has no effect on
a process that's already running — so testing against a stale instance
that predates your rebuild is an easy trap. Two defenses:

- The app itself refuses to run as a second instance
  (`app.requestSingleInstanceLock()` in `macapp/src/main/index.ts`) — a
  second `open`/double-click just focuses the already-running window
  instead of starting a confusing duplicate process.
- `npm run stop` (`scripts/kill_app.sh`) force-kills any running Stox
  process (main, helpers, and the bundled Python backend) so you can be
  sure the next launch is fresh — `npm run package:mac` and
  `npm run relaunch` both run this first automatically.

## Testing

```bash
pip install -r requirements-dev.txt   # one time
pytest                                 # runs everything under tests/
```

The suite covers each `stoxlib` module in isolation — no real network calls,
no real API keys needed (`tests/conftest.py` strips stox-related env vars
before every test so a developer's own shell exports can't leak in):

| file                  | covers                                                    |
|-----------------------|------------------------------------------------------------|
| `test_quotes.py`      | ticker normalization, EODHD response parsing, HTTP/error handling (mocked) |
| `test_news.py`        | EODHD news parsing/truncation, HTTP/error handling (mocked) |
| `test_gnews.py`       | Google News RSS parsing, redirect-link decoding, HTTP/error handling (mocked) |
| `test_webfetch.py`    | article text extraction, HTTP/error handling (mocked) |
| `test_considerations.py` | standing-consideration file parsing, dedup, and persistence |
| `test_rendering.py`   | quote/news formatting (arrows, colors, volume units, panel/table output) |
| `test_providers.py`   | provider registry resolution, missing key/package errors  |
| `test_agent.py`       | the tool-calling loop (all four tools), the read_article url allow-list, conversation-history threading/trimming, and considerations being injected into the system prompt, using a fake chat model — no LLM calls |
| `test_config.py`      | `.env` load order and precedence vs. real env vars         |
| `test_shell.py`       | input routing, command handling, the REPL loop (canned input) |
| `test_bridge.py`      | the JSON-lines protocol behind the macOS app: one command in -> the right event(s) out for each command, thread-safe concurrent `/analyze` events, history persistence and `reset` |

The macOS app itself (`macapp/`) has its own toolchain (`npm run typecheck`,
`npm run build`) — see [macOS app](#macos-app) above.

## Notes

- **Free tier = 20 API calls/day.** Batching multiple tickers into one
  request (as above) stretches this a long way.
- **Real-time on the free tier is limited to the demo tickers.** For your own
  key, real-time quotes on arbitrary tickers may need a paid plan, while
  end-of-day data is free. An `access denied` line means you've hit that gate.

## Roadmap

- [ ] Confirm live quotes with a real key
- [ ] Confirm the agent path end-to-end with a real LLM provider key
- [x] Financial news (EODHD, via the `get_stock_news` agent tool)
- [x] Full-article reading when a news summary isn't enough (`read_article`)
- [x] Conversation memory across turns in a session (`/reset` to clear it)
- [x] Standing considerations that persist across sessions (`remember_consideration`, `/considerations`)
- [x] Geopolitical/macro news (Google News RSS, via the `get_geopolitical_news` agent tool and `/analyze`'s geopolitics specialist)
- [x] Add fundamentals fetch (financials, ratios — also where company names live)
- [ ] CI (run `pytest` on push)
- [x] Native macOS app (Electron + TypeScript/React) driving the same backend via `stox_bridge.py`
- [x] Package the macOS app into a standalone double-clickable `.app` (PyInstaller-bundled backend, `npm run package:mac`)
- [ ] Custom app icon (currently the default Electron icon)
- [ ] Apple Developer ID + notarization, if the app is ever distributed beyond local personal use
