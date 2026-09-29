"""The news monitor loop: polls each monitor's queries, asks the LLM which
new headlines matter, and sends an alert for those.

One cycle, per monitor (see monitors.py for what a monitor is):

1. Search Google News (past day) for each of its queries -- headlines only,
   no link decoding or article fetching, so a poll stays cheap.
2. Drop headlines it has already seen. A brand-new monitor's first cycle
   only records what's already out there as seen ("baseline"), so creating
   one doesn't fire a burst of alerts about yesterday's news.
3. If anything is new, one LLM call triages all of it at once: which
   headlines are a material, market-moving development for the goal, and
   which tickers that points up or down. Recent alerts for the same
   monitor are in the prompt so a story that keeps generating headlines
   doesn't alert again unless it escalates.
4. Each resulting alert is logged to alerts.jsonl and sent via WhatsApp
   (notify.py). Headlines are only marked seen once triage succeeds, so an
   LLM outage delays alerts rather than dropping them.

Run as its own process by the macOS app (`stox_bridge.py --monitor`, see
macapp/src/main/monitorProcess.ts) for as long as the app is open and any
monitor exists. It writes one JSON event per line to stdout, the same
framing as bridge.py, all with id null since nothing asked for them:

    {"id": null, "type": "alert", "alert": {...}}         an alert was raised
    {"id": null, "type": "monitor_cycle", "at": ..., "monitors": n, "alerts": k}
    {"id": null, "type": "error", "message": "..."}       something failed; loop continues
"""

import json
import os
import sys
import time
import uuid

from langchain_core.messages import HumanMessage, SystemMessage

from . import config, monitors, notify
from .gnews import GNewsError, fetch_geo_news
from .providers import AgentError, build_llm

LOOKBACK = "when:1d"
PER_QUERY_LIMIT = 10
MAX_HEADLINES_PER_TRIAGE = 30
RECENT_ALERT_WINDOW_SECONDS = 24 * 3600
DEFAULT_INTERVAL_MINUTES = 10
MIN_INTERVAL_MINUTES = 2

DIRECTIONS = ("rise", "drop", "watch")
_ARROWS = {"rise": "📈", "drop": "📉", "watch": "👀"}

TRIAGE_SYSTEM = (
    "You watch breaking news for a trader and decide what is worth an "
    "alert. You get the trader's monitoring goal, the tickers they care "
    "about, alerts already sent recently, and a numbered list of new "
    "headlines. Alert only on material, market-moving developments for the "
    "goal: new events, decisions, escalations or de-escalations -- not "
    "recaps, explainers, opinion, price commentary, or stories already "
    "covered by a recent alert unless they clearly escalate it. Group "
    "headlines about the same development into one alert. Most batches "
    "deserve no alert at all.\n\n"
    "For each alert, give `direction` for the goal's subject: \"rise\" or "
    "\"drop\" when the development clearly pushes it that way, \"watch\" "
    "when it's significant but the direction is unclear. List the tickers "
    "it likely moves under `impacts`, each with its own direction (a "
    "tanker stock can rise on the same news that makes airlines drop); use "
    "the trader's tickers first and add others only if clearly affected.\n\n"
    "Reply with JSON only, no prose:\n"
    '{"alerts": [{"headlines": [1, 4], "direction": "rise", '
    '"impacts": [{"ticker": "USO", "direction": "rise"}], '
    '"title": "short label for the development", '
    '"reason": "one sentence: what happened and why it moves these"}]}\n'
    'or {"alerts": []} if nothing qualifies.'
)


def _emit(**fields):
    sys.stdout.write(json.dumps({"id": None, **fields}) + "\n")
    sys.stdout.flush()


def _key(article):
    """Google's redirect link is a stable per-article id; the title is only
    a fallback for an item without one."""
    return article.link or article.title


def collect_new(monitor, seen):
    """Search every query of `monitor` and return (new_articles, errors):
    articles whose key isn't in `seen`, deduplicated across queries (the
    same story often matches several), plus one message per failed query."""
    new, errors, keys, titles = [], [], set(), set()
    for query in monitor["queries"]:
        try:
            articles = fetch_geo_news(query, limit=PER_QUERY_LIMIT, lookback=LOOKBACK,
                                      decode_links=False)
        except GNewsError as e:
            errors.append("monitor %r, query %r: %s" % (monitor["goal"], query, e))
            continue
        for a in articles:
            key = _key(a)
            if key in seen or key in keys or a.title in titles:
                continue
            keys.add(key)
            titles.add(a.title)
            new.append(a)
    return new, errors


def _recent_alerts(monitor_id, now):
    return [
        a for a in monitors.load_alerts(limit=100)
        if a.get("monitor_id") == monitor_id
        and now - a.get("created_at", 0) < RECENT_ALERT_WINDOW_SECONDS
    ]


def _triage_prompt(monitor, articles, recent):
    lines = [
        "Goal: %s" % monitor["goal"],
        "Tickers: %s" % (", ".join(monitor["tickers"]) or "(none given)"),
        "",
        "Recent alerts already sent:",
    ]
    lines += ["- %s" % a.get("title", "") for a in recent] or ["(none)"]
    lines += ["", "New headlines:"]
    for i, a in enumerate(articles, 1):
        lines.append("[%d] %s %s %s" % (i, (a.date or "")[:16], a.title, a.summary or ""))
    return "\n".join(lines)


def _parse_json(content):
    """The model's reply as a dict, tolerating a code fence or stray prose
    around the JSON object."""
    if not isinstance(content, str):
        content = "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in the model's reply")
    return json.loads(content[start:end + 1])


def _direction(value):
    value = str(value or "").lower()
    return value if value in DIRECTIONS else "watch"


def triage(llm, monitor, articles, now=None):
    """Ask the LLM which of `articles` deserve an alert; return alert dicts
    (not yet logged or sent). Raises on an LLM or parse failure."""
    now = now or int(time.time())
    articles = articles[:MAX_HEADLINES_PER_TRIAGE]
    reply = llm.invoke([
        SystemMessage(content=TRIAGE_SYSTEM),
        HumanMessage(content=_triage_prompt(monitor, articles, _recent_alerts(monitor["id"], now))),
    ])
    data = _parse_json(reply.content)

    alerts = []
    for item in data.get("alerts") or []:
        if not isinstance(item, dict):
            continue
        picked = [articles[i - 1] for i in item.get("headlines") or []
                  if isinstance(i, int) and 1 <= i <= len(articles)]
        if not picked:
            continue
        impacts = [
            {"ticker": str(imp["ticker"]).upper(), "direction": _direction(imp.get("direction"))}
            for imp in item.get("impacts") or []
            if isinstance(imp, dict) and imp.get("ticker")
        ]
        alerts.append({
            "id": uuid.uuid4().hex[:12],
            "monitor_id": monitor["id"],
            "goal": monitor["goal"],
            "direction": _direction(item.get("direction")),
            "impacts": impacts,
            "title": str(item.get("title") or picked[0].title),
            "reason": str(item.get("reason") or ""),
            "articles": [{"title": a.title, "link": a.link, "date": a.date} for a in picked],
            "created_at": now,
        })
    return alerts


def format_message(alert):
    """The WhatsApp text for one alert."""
    lines = ["%s Stox alert: %s" % (_ARROWS[alert["direction"]], alert["title"])]
    if alert["impacts"]:
        lines.append(" · ".join(
            "%s %s" % (i["ticker"], {"rise": "↑", "drop": "↓"}.get(i["direction"], "?"))
            for i in alert["impacts"]
        ))
    if alert["reason"]:
        lines.append(alert["reason"])
    lines.append("")
    lines += ["• %s\n%s" % (a["title"], a["link"]) for a in alert["articles"][:3]]
    lines.append("")
    lines.append("Monitoring: %s" % alert["goal"])
    return "\n".join(lines)


def run_cycle(llm, send=notify.send_whatsapp, emit=_emit, now=None):
    """Check every monitor once; return the alerts raised."""
    all_monitors = monitors.load_monitors()
    state = monitors.load_state()
    raised = []

    for monitor in all_monitors:
        seen = state.get(monitor["id"])
        new, errors = collect_new(monitor, set(seen or []))
        for message in errors:
            emit(type="error", message=message)
        if seen is None:
            # Baseline: record what's already out there, alert on nothing.
            state[monitor["id"]] = [_key(a) for a in new]
            continue
        if not new:
            continue
        try:
            alerts = triage(llm, monitor, new, now=now)
        except Exception as e:
            # Left unseen, so the next cycle triages these again.
            emit(type="error", message="monitor %r: couldn't triage headlines: %s" % (monitor["goal"], e))
            continue
        seen.extend(_key(a) for a in new)

        for alert in alerts:
            try:
                send(format_message(alert))
                alert["delivered"] = True
            except notify.NotifyError as e:
                alert["delivered"] = False
                alert["delivery_error"] = str(e)
            monitors.append_alert(alert)
            emit(type="alert", alert=alert)
            raised.append(alert)

    monitors.save_state(state, {m["id"] for m in all_monitors})
    return raised


def _interval_seconds():
    try:
        minutes = float(os.environ.get("STOX_MONITOR_INTERVAL_MIN", DEFAULT_INTERVAL_MINUTES))
    except ValueError:
        minutes = DEFAULT_INTERVAL_MINUTES
    return max(minutes, MIN_INTERVAL_MINUTES) * 60


def main():
    """Poll forever; the app stops this process when it quits or the last
    monitor is deleted."""
    config.load_env()
    while True:
        started = time.time()
        if monitors.load_monitors():
            try:
                llm = build_llm()
            except AgentError as e:
                _emit(type="error", message="news monitor can't run: %s" % e)
            else:
                try:
                    raised = run_cycle(llm)
                except Exception as e:
                    _emit(type="error", message="news monitor cycle failed: %s" % e)
                else:
                    _emit(type="monitor_cycle", at=int(started),
                          monitors=len(monitors.load_monitors()), alerts=len(raised))
        time.sleep(max(0, _interval_seconds() - (time.time() - started)))


def send_test_message():
    """One-shot for Settings' "Send test message" button: exit 0 on
    success, 1 with the reason on stderr otherwise."""
    config.load_env()
    try:
        notify.send_whatsapp("✅ Stox test alert -- WhatsApp alerts are working.")
    except notify.NotifyError as e:
        sys.stderr.write(str(e) + "\n")
        sys.exit(1)
