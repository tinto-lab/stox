# stox

A tiny terminal console for looking up stock, ETF, crypto, and FX prices —
plus recent financial news — with a natural-language research mode backed
by a swappable LLM provider (Anthropic, DeepSeek, OpenAI-compatible, ...).

## Layout

```
stox.py                entry point (`python stox.py`)
stoxlib/
  quotes.py            EODHD quotes data source — Quote, fetch_quotes
  news.py              EODHD news data source — Article, fetch_news
  webfetch.py          fetches a url and extracts its readable article text
  considerations.py    standing factors the agent always weighs, persisted to disk
  rendering.py         Quote/Article -> rich console output
  providers.py         LLM provider registry (STOX_LLM_PROVIDER -> chat model)
  agent.py             natural-language question handling (LangChain tool use)
  config.py            loads .env files so keys don't need `export`ing every time
  shell.py             the REPL — routes input, owns the Console, line editing
tests/                 pytest suite, one file per stoxlib module (see Testing)
requirements.txt       pinned runtime dependencies
requirements-dev.txt   requirements.txt + pytest
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
`get_stock_news` actually returned in that conversation, never an
arbitrary url, so the model can't direct stox to fetch anything else.

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
| `test_webfetch.py`    | article text extraction, HTTP/error handling (mocked) |
| `test_considerations.py` | standing-consideration file parsing, dedup, and persistence |
| `test_rendering.py`   | quote/news formatting (arrows, colors, volume units, panel/table output) |
| `test_providers.py`   | provider registry resolution, missing key/package errors  |
| `test_agent.py`       | the tool-calling loop (all four tools), the read_article url allow-list, conversation-history threading/trimming, and considerations being injected into the system prompt, using a fake chat model — no LLM calls |
| `test_config.py`      | `.env` load order and precedence vs. real env vars         |
| `test_shell.py`       | input routing, command handling, the REPL loop (canned input) |

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
- [ ] Add fundamentals fetch (financials, ratios — also where company names live)
- [ ] CI (run `pytest` on push)
