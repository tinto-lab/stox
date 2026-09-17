# stox

A tiny terminal console for looking up stock, ETF, crypto, and FX prices,
with a natural-language mode backed by a swappable LLM provider (Anthropic,
DeepSeek, OpenAI-compatible, ...).

## Layout

```
stox.py           entry point (`python stox.py`)
stoxlib/
  quotes.py       EODHD data source — Quote, fetch_quotes
  rendering.py    Quote -> rich console output
  providers.py    LLM provider registry (STOX_LLM_PROVIDER -> chat model)
  agent.py        natural-language question handling (LangChain tool use)
  config.py       loads .env files so keys don't need `export`ing every time
  shell.py        the REPL — routes input, owns the Console, line editing
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
pip install rich requests langchain-core python-dotenv   # core deps
pip install langchain-anthropic              # STOX_LLM_PROVIDER=anthropic (default)
pip install langchain-deepseek               # STOX_LLM_PROVIDER=deepseek
pip install langchain-openai                 # STOX_LLM_PROVIDER=openai (or compatible)
```

You'll know the venv is active when your prompt shows `(.venv)` and
`which python` points at `.venv/bin/python`. Run `deactivate` to leave it.
Only install the LangChain provider package(s) you'll actually use.

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
›  what's apple trading at today?       # routed to the agent
```

Commands:

| command        | does                                     |
|----------------|-------------------------------------------|
| `<ticker> ...` | fetch quote(s)                            |
| `<question>`   | ask in plain English (needs an LLM key)   |
| `/help`        | show help                                 |
| `/clear`       | clear the screen                          |
| `/quit`        | leave (also `/exit`, Ctrl-D)              |

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

## Notes

- **Free tier = 20 API calls/day.** Batching multiple tickers into one
  request (as above) stretches this a long way.
- **Real-time on the free tier is limited to the demo tickers.** For your own
  key, real-time quotes on arbitrary tickers may need a paid plan, while
  end-of-day data is free. An `access denied` line means you've hit that gate.

## Roadmap

- [ ] Confirm live quotes with a real key
- [ ] Confirm the agent path end-to-end with a real LLM provider key
- [ ] Add fundamentals fetch (financials, ratios — also where company names live)
