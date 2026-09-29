"""News monitors: standing "alert me when ..." requests, persisted to disk.

A monitor is the user's goal in their own words ("alert me when crude oil
or tanker rates are likely to rise") plus what the agent derived from it:
a handful of short news search queries that cover the goal's drivers
("Iran", "Strait of Hormuz", "OPEC output") and the tickers it's about.
watcher.py polls those queries and decides which new headlines deserve an
alert; this module only stores things.

Three files, all under ~/.config/stox/ next to considerations.txt:

    monitors.json         the monitors -- written by the chat agent and the
                          app's Alerts panel
    monitor_state.json    headlines each monitor has already seen -- written
                          only by watcher.py
    alerts.jsonl          every alert raised, newest last -- appended only
                          by watcher.py

Every whole-file write is write-then-rename, so a reader in another process
(the app, the watcher) never sees a half-written file.
"""

import json
import time
import uuid

from .config import CONFIG_DIR

MONITORS_FILE = CONFIG_DIR / "monitors.json"
STATE_FILE = CONFIG_DIR / "monitor_state.json"
ALERTS_FILE = CONFIG_DIR / "alerts.jsonl"

# Per monitor. A monitor with 6 queries sees at most ~60 headlines a poll,
# and a headline only needs remembering for as long as the feed's lookback
# window still returns it, so this comfortably covers a day.
MAX_SEEN_PER_MONITOR = 1000


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n")
    tmp.replace(path)


def _read_json(path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def load_monitors() -> list[dict]:
    data = _read_json(MONITORS_FILE, {})
    monitors = data.get("monitors") if isinstance(data, dict) else None
    if not isinstance(monitors, list):
        return []
    return [m for m in monitors if isinstance(m, dict) and m.get("id") and m.get("queries")]


def add_monitor(goal, queries, tickers) -> dict:
    """Store a new monitor and return it. Blank queries/tickers are dropped
    and tickers upper-cased; raises ValueError if no query is left."""
    queries = [q.strip() for q in queries or [] if q and q.strip()]
    if not queries:
        raise ValueError("a monitor needs at least one search query")
    monitor = {
        "id": uuid.uuid4().hex[:8],
        "goal": (goal or "").strip() or queries[0],
        "queries": queries,
        "tickers": [t.strip().upper() for t in tickers or [] if t and t.strip()],
        "created_at": int(time.time()),
    }
    _write_json(MONITORS_FILE, {"monitors": load_monitors() + [monitor]})
    return monitor


def remove_monitor(monitor_id) -> bool:
    """Delete a monitor (and its seen-headline state); False if no such id."""
    monitors = load_monitors()
    remaining = [m for m in monitors if m["id"] != monitor_id]
    if len(remaining) == len(monitors):
        return False
    _write_json(MONITORS_FILE, {"monitors": remaining})
    return True


def load_state() -> dict:
    """{monitor_id: [seen headline key, ...]}, oldest first."""
    data = _read_json(STATE_FILE, {})
    return data if isinstance(data, dict) else {}


def save_state(state, monitor_ids):
    """Persist `state`, dropping deleted monitors and capping each list."""
    _write_json(STATE_FILE, {
        mid: seen[-MAX_SEEN_PER_MONITOR:] for mid, seen in state.items() if mid in monitor_ids
    })


def append_alert(alert):
    ALERTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with ALERTS_FILE.open("a") as f:
        f.write(json.dumps(alert) + "\n")


def load_alerts(limit=50) -> list[dict]:
    """The most recent `limit` alerts, newest first."""
    try:
        lines = ALERTS_FILE.read_text().splitlines()
    except OSError:
        return []
    alerts = []
    for line in reversed(lines):
        try:
            alerts.append(json.loads(line))
        except ValueError:
            continue
        if len(alerts) >= limit:
            break
    return alerts
