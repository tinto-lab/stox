"""JSON-lines bridge: lets a separate frontend process (e.g. a native app)
drive the same backend the terminal REPL uses, without owning a console or
a TTY.

Reads one JSON command per line from stdin, dispatches to the existing
stoxlib functions (agent.ask_agent, analysis.run_stock_analysis,
quotes.fetch_quotes, considerations.*, config.load_env), and writes one
JSON event per line to stdout -- nothing else is ever written there, so a
caller can safely parse stdout line-by-line. This module owns no behavior
of its own beyond wiring and serialization; shell.py (the terminal REPL)
is untouched and keeps working exactly as before.

One process handles one session: `history` is held in memory for the
process's lifetime, same as the REPL's own `history` list, so multi-turn
memory and a `reset` command behave identically to `/reset`.
"""

import json
import os
import sys
import threading

from . import agent, analysis, considerations, config, providers, quotes

_write_lock = threading.Lock()


def _default(obj):
    """json.dumps(default=...) hook: every result object stox returns
    (Quote, Bar, Fundamentals, Article, GeoArticle, AgentResult,
    AnalysisResult, ...) is a plain attribute bag, so __dict__ is enough --
    json re-applies this hook to whatever it returns, so nested objects
    (e.g. AgentResult.analysis, an AnalysisResult) serialize too."""
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    return str(obj)


def _emit(request_id, **fields):
    """Write one JSON event line, tagged with the request id it answers.
    Guarded by a lock: /analyze's on_tool_call fires from up to 4 worker
    threads concurrently, and an interleaved write would corrupt a line."""
    line = json.dumps({"id": request_id, **fields}, default=_default)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _handle_quote(request_id, payload, session):
    tickers = payload.get("tickers") or []
    try:
        found, missing = quotes.fetch_quotes(tickers)
    except quotes.QuoteError as e:
        _emit(request_id, type="error", message=str(e))
        return
    _emit(request_id, type="result", data={"quotes": found, "missing": missing})


def _handle_ask(request_id, payload, session):
    text = payload.get("text", "")

    def on_tool_call(name, args):
        _emit(request_id, type="tool_call", name=name, args=args)

    def on_analysis_agent_start(name):
        _emit(request_id, type="specialist_start", name=name)

    def on_analysis_tool_call(agent_name, name, args):
        _emit(request_id, type="specialist_tool_call", agent=agent_name, name=name, args=args)

    result = agent.ask_agent(
        text, history=session["history"], on_tool_call=on_tool_call,
        on_analysis_agent_start=on_analysis_agent_start,
        on_analysis_tool_call=on_analysis_tool_call,
    )
    if result.error:
        _emit(request_id, type="error", message=result.error)
        return
    _emit(request_id, type="result", data=result)


def _handle_analyze(request_id, payload, session):
    ticker = payload.get("ticker", "")

    def on_agent_start(name):
        _emit(request_id, type="specialist_start", name=name)

    def on_tool_call(agent_name, name, args):
        _emit(request_id, type="specialist_tool_call", agent=agent_name, name=name, args=args)

    result = analysis.run_stock_analysis(ticker, on_agent_start=on_agent_start, on_tool_call=on_tool_call)
    if result.error:
        _emit(request_id, type="error", message=result.error)
        return
    agent.record_analysis(session["history"], quotes.normalize(ticker), result)
    _emit(request_id, type="result", data=result)


def _handle_reset(request_id, payload, session):
    session["history"].clear()
    _emit(request_id, type="result", data={})


def _handle_considerations_list(request_id, payload, session):
    _emit(request_id, type="result", data={"considerations": considerations.load_considerations()})


def _handle_considerations_add(request_id, payload, session):
    considerations.add_consideration(payload.get("text", ""))
    _emit(request_id, type="result", data={"considerations": considerations.load_considerations()})


def _handle_considerations_remove(request_id, payload, session):
    """No delete function exists on considerations.py by design (the file
    is plain text, meant to be hand-editable) -- rewrite it directly here
    rather than adding one, since the format is a single filter+join."""
    target = (payload.get("text") or "").strip()
    remaining = [c for c in considerations.load_considerations() if c != target]
    considerations.CONSIDERATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    considerations.CONSIDERATIONS_FILE.write_text("".join(c + "\n" for c in remaining))
    _emit(request_id, type="result", data={"considerations": remaining})


def _handle_status(request_id, payload, session):
    provider = providers.current_provider_name()
    cfg = providers.LLM_PROVIDERS.get(provider)
    provider_key_present = bool(cfg and os.environ.get(cfg["api_key_env"]))
    _emit(request_id, type="result", data={
        "eodhd_key": bool(os.environ.get("EODHD_API_KEY")),
        "webz_key": bool(os.environ.get("WEBZ_API_KEY")),
        "provider": provider,
        "model": providers.describe_current(),
        "provider_key_present": provider_key_present,
    })


_HANDLERS = {
    "quote": _handle_quote,
    "ask": _handle_ask,
    "analyze": _handle_analyze,
    "reset": _handle_reset,
    "considerations_list": _handle_considerations_list,
    "considerations_add": _handle_considerations_add,
    "considerations_remove": _handle_considerations_remove,
    "status": _handle_status,
}


def main():
    config.load_env()
    session = {"history": []}

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            _emit(None, type="error", message="invalid JSON")
            continue

        request_id = payload.get("id")
        handler = _HANDLERS.get(payload.get("cmd"))
        if handler is None:
            _emit(request_id, type="error", message="unknown command: %s" % payload.get("cmd"))
            continue

        try:
            handler(request_id, payload, session)
        except Exception as e:
            _emit(request_id, type="error", message="internal error: %s" % e)


if __name__ == "__main__":
    main()
