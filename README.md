# stox

A tiny stock research console for looking up stock, ETF, crypto, and FX
prices and recent financial news, with a natural-language research mode
backed by a swappable LLM provider (Anthropic, DeepSeek, OpenAI-compatible, ...).

There are two frontends on one TypeScript core: the terminal REPL (`./stox`,
below) and a native macOS app (`macapp/`, see [macOS app](#macos-app)). The
app is a stock price and fundamentals dashboard, with the REPL's research
chat available as a side panel.

## Layout

```
stox                    terminal entry point (`./stox`) -- runs macapp/src/cli/ via tsx
macapp/                 the Node/TypeScript project: core, CLI, and the Electron app
  src/core/             everything both frontends share -- no Electron, no UI
    config.ts           ~/.config/stox/ and .env loading
    marketData.ts       EODHD quotes/history/news/search, Yahoo Finance fundamentals
    gnews.ts            Google News RSS world/geopolitical news (free, keyless)
    webfetch.ts         fetches a url and extracts its readable article text
    llm.ts              LLM provider registry, Anthropic/OpenAI adapters, the shared tool loop
    tools.ts            the data-lookup tools the agents call (quote/news/history/...)
    agent.ts            the chat agent: natural-language questions via tool use
    analysis.ts         the /analyze multi-agent trend/fundamentals/news/geopolitics pipeline
    considerations.ts   standing factors the agent always weighs, persisted to disk
    monitors.ts         news monitors ("alert me when ...") and their alert log
    watcher.ts          the news monitor loop: poll, LLM triage, alert
    notify.ts           alert delivery -- WhatsApp via CallMeBot
    session.ts          one chat conversation driven by commands -- the app's chat backend
  src/cli/              the terminal REPL (shell.ts) and its rendering (render.ts)
  src/main/             Electron main process: windows, IPC, the monitor service
  src/preload/          the window.stox API exposed to the renderer
  src/renderer/         the React UI
  src/shared/           types and the chat protocol, shared by all of the above
  test/                 vitest suite (see Testing)
scripts/kill_app.sh     stops any running Stox.app (used by `npm run package:mac`)
```

Each core module has one job; the module comments say which.

## Requirements

- Node.js 22+ (developed on 24)
- An EODHD API key — the free `demo` key works for testing, no signup
- For plain-English questions: an API key for whichever LLM provider you pick

## Setup

```bash
cd macapp
npm install       # one time
```

That's all -- `./stox` at the repo root runs the CLI from source.

## Running it

### Option A: a .env file (recommended — set once, no more `export`ing)

```bash
cp .env.example .env      # repo-local; or ~/.config/stox/.env for every checkout
$EDITOR .env               # fill in the keys you need
./stox
```

Both files are loaded automatically on startup (the repo `.env` overrides the
`~/.config/stox/.env` one; a real `export`ed env var always wins over either).
The macOS app's Settings panel edits `~/.config/stox/.env`, so a key set
there works in the CLI too. `.env` is git-ignored — never commit it.

### Option B: export in your shell

```bash
export EODHD_API_KEY=demo      # test key — see supported tickers below
./stox
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
for history (persisted across sessions in `~/.config/stox/history`), and
Ctrl+A/E for start/end of line. Ctrl+C cancels a question that's still
running; at the prompt it leaves.

## Usage

Ask about a stock in any language at the `›` prompt, or use `/price` for an
instant quote:

```
›  /price AAPL
›  /price TSLA MSFT NVDA                # several at once = one API call
›  what's apple trading at today?       # the agent looks up a quote
›  any news on tesla?                   # the agent looks up news
›  what about its news?                 # remembers "tesla" from the last question
›  should I buy nvidia?                 # the agent runs the full /analyze
```

Commands:

| command        | does                                                    |
|----------------|-----------------------------------------------------------|
| `<question>`   | ask in plain English — the agent decides what to look up (needs an LLM key) |
| `/price <ticker> ...` | instant quote(s), no LLM involved                  |
| `/analyze <ticker>` | trend, fundamentals, news and geopolitics specialists, then a risk assessment |
| `/help`        | show help                                                  |
| `/clear`       | clear the screen                                           |
| `/reset`       | forget the conversation so far (also `/new`)               |
| `/considerations` | list standing factors the agent always weighs (also `/remembered`) |
| `/quit`        | leave (also `/exit`, Ctrl-D)                               |

The agent has tools for quotes, price history, fundamentals and news. News
comes from EODHD (same key as quotes) via `get_stock_news`, which includes
each article's full text where the page can be read, falling back to
EODHD's short summary. When that isn't enough, the agent can call
`read_article` to read one article in full — but only for a url that
`get_stock_news` or `get_geopolitical_news` actually returned in that
conversation, never an arbitrary url, so the model can't direct stox to
fetch anything else.

For forces beyond one company — tariffs, sanctions, elections,
central-bank decisions, regional conflict — the agent can call
`get_geopolitical_news`, which searches general world news by free-text
query instead of a ticker, via Google News RSS (free, no key). `/analyze`
also runs a dedicated geopolitics specialist alongside trend/fundamentals/
news, folding whatever it finds into the aggregated risk assessment.

Every tool call the model makes is printed before its result, so it's never
a black box what ran:

```
› any news on tesla?
→ agent (anthropic/claude-opus-5) · any news on tesla?
  ↳ get_stock_news(tickers=[ 'TSLA' ], limit=5)
Tesla has a couple of headlines today.
```

With the Anthropic provider on a model that supports it, requests opt into
the API's server-side refusal fallback: if a safety classifier declines a
request, the API retries it on a fallback model instead of returning a bare
refusal.

### Conversation memory

The agent remembers the current session: follow-ups like "what about its
news?" or "read that first one in full" resolve against earlier turns,
`/analyze` results included. History is kept in memory only (nothing is
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

### News alerts

Ask the chat to watch something -- "alert me when crude oil or oil
shipping prices may rise" -- and the agent calls `create_news_monitor`:
it works out what news would move that (Iran, Strait of Hormuz, OPEC
output, tanker rates ...) and the tickers involved (USO, XOM, FRO), and
saves a monitor to `~/.config/stox/monitors.json`. `list_news_monitors`
and `delete_news_monitor` manage them from chat; the app's **Alerts**
panel lists them too, with every alert raised.

While the app is open and any monitor exists, its main process runs the
watcher (`src/core/watcher.ts`). Every 10 minutes
(`STOX_MONITOR_INTERVAL_MIN`) it searches Google News for each monitor's
queries (past day, headlines only), and sends just the headlines it hasn't
seen to the LLM in one triage call per monitor. The LLM decides which are
material developments and which tickers they push up or down, and gets
recent alerts too so the same story doesn't re-alert unless it escalates.
A new monitor's first check only records what's already out there, so it
doesn't alert on old news. Without the app, `./stox monitor` runs the same
loop in the foreground.

Alerts go to WhatsApp via [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/),
a free personal-use relay: message their bot once to get an API key, then
set `CALLMEBOT_PHONE` and `CALLMEBOT_APIKEY` in Settings (which also has a
"send test message" button; `./stox test-alert` does the same). Without
them, alerts still show in the Alerts panel and in
`~/.config/stox/alerts.jsonl`.

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
- **Research chat** (⌘J) — a side panel with the same agent the terminal
  REPL has (plain-English questions, `/price`, `/analyze`, `/reset`,
  standing considerations). The stock view's "Analyze in chat" button runs
  `/analyze` there.

Everything runs in the app's main process on `src/core/`: market data
(EODHD for quotes, history and symbol search, Yahoo Finance for
fundamentals), the chat (`ChatSession`, reached from the renderer over IPC
with the commands and events in `src/shared/bridgeProtocol.ts`), and the
news watcher. There's no separate backend process.

### Running it (development)

```bash
cd macapp
npm install     # one time
npm run dev
```

The dashboard opens empty: search for a stock (⌘K), open it, and pin it.
Open the research chat with the Chat button or ⌘J. Settings (the EODHD key,
the chat's LLM provider/model and keys, WhatsApp) are saved to
`~/.config/stox/.env`, the same file the CLI reads. In development the
app also reads the repo's own `.env`, as the CLI does.

`npm run typecheck` and `npm run build` (a one-off production build, output
to `macapp/out/`) are also available.

### Packaging a standalone `.app`

```bash
cd macapp
npm run relaunch     # kill any running instance, rebuild, sign, open the fresh build
```

`npm run relaunch` is the one-command dev loop: it runs `npm run stop`
(kills any Stox process still running — see below), `electron-vite build`,
`electron-builder` (producing `macapp/dist/mac-arm64/Stox.app`), an ad-hoc
`codesign` (electron-builder's `identity: null` config skips signing
entirely; ad-hoc signing avoids a repeated Gatekeeper prompt on every local
launch — a paid Apple Developer ID + notarization would only be needed to
distribute the app to other people, out of scope for a personal tool),
then opens the result. Use `npm run package:mac` instead if you don't want
it to also open the app.

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
  process so you can be sure the next launch is fresh — `npm run
  package:mac` and `npm run relaunch` both run this first automatically.

## Testing

```bash
cd macapp
npm test             # vitest, everything under test/
npm run typecheck
```

The suite covers the core, the CLI and the chat session in isolation — no
real network calls and no real API keys. `test/setup.ts` gives every test a
throwaway HOME (so `~/.config/stox/` is a temp dir) and strips the env vars
stox reads, so a developer's own keys or files can't leak in or be written:

| file                  | covers                                                    |
|-----------------------|------------------------------------------------------------|
| `marketData.test.ts`  | ticker normalization, EODHD quote/history/news parsing, Yahoo fundamentals, HTTP/error handling (mocked fetch) |
| `sources.test.ts`     | Google News parsing, redirect-link decoding and caching, article extraction, CallMeBot (mocked fetch) |
| `webfetch.test.ts`    | article fetching: truncation and error handling            |
| `stores.test.ts`      | `.env` loading and precedence, considerations, monitors/alerts/seen-state files |
| `llm.test.ts`         | provider registry, Anthropic/OpenAI message conversion and parsing, the tool loop's round budget |
| `tools.test.ts`       | every data tool's result text, full-text fallback, errors  |
| `agent.test.ts`       | the chat agent with a scripted model: every tool, the read_article allow-list, considerations, monitors, history threading/trimming |
| `analysis.test.ts`    | the four specialists (concurrency, tool slices, search budget, forced final answer) and the aggregator |
| `watcher.test.ts`     | the monitor cycle: baseline, dedup, triage parsing, retry after a triage failure, delivery failures |
| `session.test.ts`     | the app's chat protocol: each command's events, history and `reset`, restart dropping in-flight requests |
| `cli.test.ts`         | terminal rendering and REPL command handling               |

## Notes

- **Free tier = 20 API calls/day.** Batching multiple tickers into one
  request (as above) stretches this a long way.
- **Real-time on the free tier is limited to the demo tickers.** For your own
  key, real-time quotes on arbitrary tickers may need a paid plan, while
  end-of-day data is free. An `access denied` line means you've hit that gate.

## Roadmap

- [ ] Confirm live quotes with a real key
- [x] Confirm the agent path end-to-end with a real LLM provider key
- [x] Financial news (EODHD, via the `get_stock_news` agent tool)
- [x] Full-article reading when a news summary isn't enough (`read_article`)
- [x] Conversation memory across turns in a session (`/reset` to clear it)
- [x] Standing considerations that persist across sessions (`remember_consideration`, `/considerations`)
- [x] Geopolitical/macro news (Google News RSS, via the `get_geopolitical_news` agent tool and `/analyze`'s geopolitics specialist)
- [x] Add fundamentals fetch (financials, ratios — also where company names live)
- [ ] CI (run `npm test` on push)
- [x] Native macOS app (Electron + TypeScript/React)
- [x] Package the macOS app into a standalone double-clickable `.app` (`npm run package:mac`)
- [x] One TypeScript core for the CLI and the app (was a Python backend bundled with PyInstaller)
- [ ] Custom app icon (currently the default Electron icon)
- [x] News monitors with WhatsApp alerts (`create_news_monitor`, the app's Alerts panel)
- [ ] More alert channels (Telegram, email), and monitoring while the app is closed (launchd)
- [ ] Apple Developer ID + notarization, if the app is ever distributed beyond local personal use
