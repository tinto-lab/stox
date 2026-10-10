# stox

A tiny stock research console for looking up stock, ETF, crypto, and FX
prices and recent financial news, with a natural-language research mode
backed by a swappable LLM provider (DeepSeek, OpenAI, or any OpenAI-compatible API).

There are two frontends on one TypeScript core: the terminal REPL (`stox`,
below) and a native macOS app (see [macOS app](#macos-app)). The
app is a stock price and fundamentals dashboard, with the REPL's research
chat available as a side panel.

## Layout

```
src/core/               everything both frontends share -- no Electron, no UI
  config.ts             ~/.config/stox/ and .env loading
  marketData.ts         EODHD quotes/history/news/search, Yahoo Finance fundamentals
  gnews.ts              Google News RSS world/geopolitical news (free, keyless)
  webfetch.ts           fetches a url and extracts its readable article text
  llm.ts                LLM provider registry, the OpenAI-compatible adapter, the shared tool loop
  tools.ts              the data-lookup tools the agents call (quote/news/history/...)
  agent.ts              the chat agent: natural-language questions via tool use
  analysis.ts           the /analyze multi-agent trend/fundamentals/news/geopolitics pipeline
  considerations.ts     standing factors the agent always weighs, persisted to disk
  conversations.ts      saved chat conversations (resume later), titled by a short LLM summary
  session.ts            one chat conversation driven by commands -- the app's chat backend
  whisper.ts            runs whisper.cpp's whisper-server and downloads its model
  voiceSession.ts       streaming dictation: live preview while speaking, commit after a pause
src/cli/                the terminal REPL (shell.ts) and its rendering (render.ts)
src/main/               Electron main process: windows, IPC
src/preload/            the window.stox API exposed to the renderer
src/renderer/           the React UI
src/shared/             types and the chat protocol, shared by all of the above
test/                   vitest suite (see Testing)
scripts/kill_app.sh     stops any running Stox.app (used by `npm run package:mac`)
scripts/fetch-whisper.sh  builds the whisper-server binary into build/bin/ (see Voice dictation)
```

Each core module has one job; the module comments say which.

## Requirements

- Node.js 22+ (developed on 24) -- installs dependencies, runs the app and tests
- [Bun](https://bun.sh) (`brew install oven-sh/bun/bun`) -- runs and builds the CLI
- An EODHD API key — the free `demo` key works for testing, no signup
- For plain-English questions: an API key for whichever LLM provider you pick

## Setup

```bash
npm install       # one time
```

That's all -- `npm run cli` runs the CLI from source. For a `stox` command
you can run from anywhere, build the [standalone binary](#a-standalone-binary).

## Running it

### Option A: a .env file (recommended — set once, no more `export`ing)

```bash
cp .env.example .env      # repo-local; or ~/.config/stox/.env for every checkout
$EDITOR .env               # fill in the keys you need
npm run cli
```

Both files are loaded automatically on startup (the repo `.env` overrides the
`~/.config/stox/.env` one; a real `export`ed env var always wins over either).
The macOS app's Settings panel edits `~/.config/stox/.env`, so a key set
there works in the CLI too. `.env` is git-ignored — never commit it.

### Option B: export in your shell

```bash
export EODHD_API_KEY=demo      # test key — see supported tickers below
npm run cli
```

Swap `demo` for your own free key from https://eodhd.com once the wiring
checks out.

For plain-English questions, also set an LLM provider (defaults to
`deepseek` if unset):

```bash
export STOX_LLM_PROVIDER=deepseek     # deepseek | openai
export STOX_LLM_MODEL=deepseek-chat   # optional, each provider has a default
export DEEPSEEK_API_KEY=...           # whichever provider you picked
```

### A standalone binary

`npm run cli` needs Bun and `node_modules`. To get one self-contained
`stox` executable instead (about 60 MB, Bun's runtime included):

```bash
npm run build:cli        # -> dist/stox
cp dist/stox ~/.local/bin/   # or anywhere on your PATH
```

It runs only on the OS and CPU it was built on. It reads keys the same way
as `npm run cli`, except that the repo `.env` is only found on the machine it was
built on, so put keys in `~/.config/stox/.env` (or export them) anywhere else.

### Thinking mode (DeepSeek)

DeepSeek models can think before answering: slower, but more careful,
especially for `/analyze`. It's off by default. Switch it any time with
`/think on` / `/think off` in the CLI or the **Thinking** button in the
app's chat panel. It applies from the next question, the conversation
carries on, and the choice is saved as `STOX_LLM_THINKING` in
`~/.config/stox/.env`, so the CLI and the app share it. Other providers
keep their model's own behavior and don't show the switch.

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
| `/reset`       | start a new conversation; the last one is saved (also `/new`) |
| `/resume [n]`  | list saved conversations, or pick up number n             |
| `/considerations` | list standing factors the agent always weighs (also `/remembered`) |
| `/think [on\|off]` | show or switch thinking mode (DeepSeek)                  |
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
→ agent (deepseek/deepseek-chat) · any news on tesla?
  ↳ get_stock_news(tickers=[ 'TSLA' ], limit=5)
Tesla has a couple of headlines today.
```

### Conversation memory

The agent remembers the current session: follow-ups like "what about its
news?" or "read that first one in full" resolve against earlier turns,
`/analyze` results included. What the model sees is capped at the most
recent 6 turns to bound token cost, trimmed only at safe turn boundaries.
Within a question the agent's tool loop is capped at 10 rounds. Run
`/reset` (or `/new`) to start a clean conversation without restarting stox.

### Saved conversations

Conversations are saved as you go, one JSON file each under
`~/.config/stox/conversations/` (the newest 100 are kept), titled with a
short summary of the first question. Only questions you ask are saved, not
typed `/price` or `/analyze` commands. `/resume` lists them and
`/resume <n>` picks one up again, in the CLI or in the app's chat panel
(History button), which share the folder. The files are plain text, safe
to delete.

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

Stox is also a native macOS app (Electron + TypeScript/React) for checking
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
  standing considerations, saved conversations). The stock view's
  "Analyze in chat" button runs `/analyze` there, and clicking a point on a
  price chart inserts it into the chat input.
- **Voice dictation** — speak into the chat input instead of typing; see
  below.
- **Settings** — API keys, the chat's LLM provider/model, light/dark theme
  and the dictation setup.

Everything runs in the app's main process on `src/core/`: market data
(EODHD for quotes, history and symbol search, Yahoo Finance for
fundamentals), the chat (`ChatSession`, reached from the renderer over IPC
with the commands and events in `src/shared/bridgeProtocol.ts`). There's
no separate backend process.

### Voice dictation

Hold Space for half a second in the chat input (or click the wave button)
to dictate; Esc cancels. Speech is transcribed locally by
[whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server`,
so audio never leaves the machine. Text appears in the draft while you
talk and is committed after a pause.

Setup is in Settings > Voice dictation: download the model (about 60 MB,
stored in `~/.config/stox/models/`), start or stop the engine, and choose
the spoken language (`auto` by default; saved in `preferences.json`).
Giving a language avoids short phrases being misdetected. The mic button
shows a status light.

The server binary isn't in git. Build it once with
`scripts/fetch-whisper.sh` (needs git and cmake: `brew install cmake`);
it lands in `build/bin/` and is bundled into the packaged app.

### Running it (development)

```bash
npm install     # one time
npm run dev
```

The dashboard opens empty: search for a stock (⌘K), open it, and pin it.
Open the research chat with the Chat button or ⌘J. Settings (the EODHD key,
the chat's LLM provider/model and keys) are saved to
`~/.config/stox/.env`, the same file the CLI reads. In development the
app also reads the repo's own `.env`, as the CLI does.

`npm run typecheck` and `npm run build` (a one-off production build, output
to `out/`) are also available.

### Packaging a standalone `.app`

```bash
npm run relaunch     # kill any running instance, rebuild, sign, open the fresh build
```

`npm run relaunch` is the one-command dev loop: it runs `npm run stop`
(kills any Stox process still running — see below), `electron-vite build`,
`electron-builder` (producing `dist/mac-arm64/Stox.app`), an ad-hoc
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
  (`app.requestSingleInstanceLock()` in `src/main/index.ts`) — a
  second `open`/double-click just focuses the already-running window
  instead of starting a confusing duplicate process.
- `npm run stop` (`scripts/kill_app.sh`) force-kills any running Stox
  process so you can be sure the next launch is fresh — `npm run
  package:mac` and `npm run relaunch` both run this first automatically.

## Testing

```bash
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
| `sources.test.ts`     | Google News parsing, redirect-link decoding and caching, article extraction (mocked fetch) |
| `webfetch.test.ts`    | article fetching: truncation and error handling            |
| `stores.test.ts`      | `.env` loading and precedence, considerations |
| `conversations.test.ts` | saving, titling, listing and resuming conversations     |
| `voice.test.ts`       | dictation: speech detection, WAV encoding, streaming preview and commit |
| `liveBar.test.ts`     | merging the live quote into the chart (latest bar, period change)|
| `llm.test.ts`         | provider registry, OpenAI-format message conversion and parsing, the tool loop's round budget |
| `tools.test.ts`       | every data tool's result text, full-text fallback, errors  |
| `agent.test.ts`       | the chat agent with a scripted model: every tool, the read_article allow-list, considerations, history threading/trimming |
| `analysis.test.ts`    | the four specialists (concurrency, tool slices, search budget, forced final answer) and the aggregator |
| `session.test.ts`     | the app's chat protocol: each command's events, history and `reset`, restart dropping in-flight requests |
| `cli.test.ts`         | terminal rendering and REPL command handling               |

## Notes

- **Free tier = 20 API calls/day.** Batching multiple tickers into one
  request (as above) stretches this a long way.
- **Real-time on the free tier is limited to the demo tickers.** For your own
  key, real-time quotes on arbitrary tickers may need a paid plan, while
  end-of-day data is free. An `access denied` line means you've hit that gate.
