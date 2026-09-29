import json
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage

from stoxlib import monitors, watcher
from stoxlib.gnews import GeoArticle, GNewsError
from stoxlib.notify import NotifyError

NOW = 1_800_000_000


def _art(n):
    return GeoArticle(title="Headline %d" % n, date="2026-09-29T10:00:00+00:00",
                      link="https://news.google.com/rss/articles/%d" % n, country="",
                      sentiment="", summary="(headline only, from Reuters)")


class _FakeLLM:
    def __init__(self, *replies):
        self._replies = list(replies)
        self.received = []

    def invoke(self, messages):
        self.received.append(messages)
        reply = self._replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return AIMessage(content=reply)


def _reply(**alert):
    return json.dumps({"alerts": [alert]})


OIL_ALERT = dict(headlines=[2], direction="rise", title="Hormuz threat",
                 impacts=[{"ticker": "uso", "direction": "rise"},
                          {"ticker": "DAL", "direction": "drop"}],
                 reason="Iran threatens to close the strait.")


@pytest.fixture
def monitor():
    return monitors.add_monitor("oil up", ["Iran", "OPEC"], ["USO"])


def _feed(by_query):
    def fake(query, **kwargs):
        assert kwargs == {"limit": watcher.PER_QUERY_LIMIT, "lookback": watcher.LOOKBACK,
                          "decode_links": False}
        result = by_query[query]
        if isinstance(result, Exception):
            raise result
        return result
    return patch("stoxlib.watcher.fetch_geo_news", side_effect=fake)


def _cycle(llm, send=None, events=None):
    sent = []
    events = events if events is not None else []
    raised = watcher.run_cycle(llm, send=send or sent.append,
                               emit=lambda **e: events.append(e), now=NOW)
    return raised, sent, events


def test_first_cycle_is_a_silent_baseline(monitor):
    llm = _FakeLLM()
    with _feed({"Iran": [_art(1)], "OPEC": [_art(2)]}):
        raised, sent, _ = _cycle(llm)

    assert raised == [] and sent == [] and llm.received == []
    assert set(monitors.load_state()[monitor["id"]]) == {_art(1).link, _art(2).link}


def test_new_headlines_are_triaged_alerted_and_logged(monitor):
    llm = _FakeLLM(_reply(**OIL_ALERT))
    with _feed({"Iran": [_art(1)], "OPEC": []}):
        _cycle(_FakeLLM())
    with _feed({"Iran": [_art(1), _art(2)], "OPEC": [_art(3), _art(2)]}):
        raised, sent, events = _cycle(llm)

    # Only unseen headlines, deduplicated across queries, reach the model.
    prompt = llm.received[0][1].content
    assert "Headline 1" not in prompt
    assert "[1] 2026-09-29T10:00 Headline 2" in prompt
    assert "[2] 2026-09-29T10:00 Headline 3" in prompt
    assert "Goal: oil up" in prompt

    (alert,) = raised
    assert alert["articles"] == [{"title": "Headline 3", "link": _art(3).link, "date": _art(3).date}]
    assert alert["impacts"] == [{"ticker": "USO", "direction": "rise"},
                                {"ticker": "DAL", "direction": "drop"}]
    assert alert["delivered"] is True
    assert alert["created_at"] == NOW
    assert monitors.load_alerts() == [alert]
    assert events == [{"type": "alert", "alert": alert}]

    (message,) = sent
    assert message.startswith("📈 Stox alert: Hormuz threat")
    assert "USO ↑ · DAL ↓" in message
    assert _art(3).link in message

    seen = monitors.load_state()[monitor["id"]]
    assert {_art(2).link, _art(3).link} <= set(seen)


def test_nothing_new_skips_the_llm(monitor):
    with _feed({"Iran": [_art(1)], "OPEC": []}):
        _cycle(_FakeLLM())
        llm = _FakeLLM()
        assert _cycle(llm)[0] == []
    assert llm.received == []


def test_triage_failure_leaves_headlines_unseen_for_next_cycle(monitor):
    with _feed({"Iran": [], "OPEC": []}):
        _cycle(_FakeLLM())
    with _feed({"Iran": [_art(1)], "OPEC": []}):
        _, _, events = _cycle(_FakeLLM(RuntimeError("rate limited")))
        assert "couldn't triage" in events[0]["message"]
        assert monitors.load_state()[monitor["id"]] == []

        raised, _, _ = _cycle(_FakeLLM(_reply(**{**OIL_ALERT, "headlines": [1]})))
    assert len(raised) == 1


def test_delivery_failure_still_logs_the_alert(monitor):
    def failing_send(text):
        raise NotifyError("not set up")

    with _feed({"Iran": [], "OPEC": []}):
        _cycle(_FakeLLM())
    with _feed({"Iran": [_art(1)], "OPEC": []}):
        (alert,), _, _ = _cycle(_FakeLLM(_reply(**{**OIL_ALERT, "headlines": [1]})),
                                send=failing_send)

    assert alert["delivered"] is False
    assert alert["delivery_error"] == "not set up"
    assert monitors.load_alerts() == [alert]


def test_query_error_is_reported_and_others_still_run(monitor):
    with _feed({"Iran": GNewsError("HTTP 503"), "OPEC": [_art(1)]}):
        _, _, events = _cycle(_FakeLLM())
    assert "HTTP 503" in events[0]["message"]
    assert monitors.load_state()[monitor["id"]] == [_art(1).link]


def test_recent_alerts_are_in_the_prompt(monitor):
    monitors.append_alert({"monitor_id": monitor["id"], "title": "Old news", "created_at": NOW - 100})
    monitors.append_alert({"monitor_id": monitor["id"], "title": "Ancient", "created_at": NOW - 90000})
    monitors.append_alert({"monitor_id": "other", "title": "Elsewhere", "created_at": NOW})
    llm = _FakeLLM('{"alerts": []}')

    assert watcher.triage(llm, monitor, [_art(1)], now=NOW) == []
    prompt = llm.received[0][1].content
    assert "- Old news" in prompt
    assert "Ancient" not in prompt and "Elsewhere" not in prompt


def test_triage_tolerates_fences_and_drops_bad_items(monitor):
    reply = "```json\n" + json.dumps({"alerts": [
        {"headlines": [9], "direction": "rise"},       # out of range -> dropped
        "junk",
        {"headlines": [1], "direction": "sideways", "impacts": [{"direction": "rise"}]},
    ]}) + "\n```"
    (alert,) = watcher.triage(_FakeLLM(reply), monitor, [_art(1)], now=NOW)

    assert alert["direction"] == "watch"
    assert alert["impacts"] == []
    assert alert["title"] == "Headline 1"


def test_triage_accepts_content_blocks(monitor):
    llm = _FakeLLM([{"type": "text", "text": '{"alerts": []}'}])
    assert watcher.triage(llm, monitor, [_art(1)], now=NOW) == []


def test_triage_raises_on_non_json(monitor):
    with pytest.raises(ValueError):
        watcher.triage(_FakeLLM("no idea"), monitor, [_art(1)], now=NOW)


def test_deleted_monitor_state_is_dropped(monitor):
    with _feed({"Iran": [_art(1)], "OPEC": []}):
        _cycle(_FakeLLM())
    monitors.remove_monitor(monitor["id"])
    _cycle(_FakeLLM())
    assert monitors.load_state() == {}


def test_interval_env(monkeypatch):
    assert watcher._interval_seconds() == watcher.DEFAULT_INTERVAL_MINUTES * 60
    monkeypatch.setenv("STOX_MONITOR_INTERVAL_MIN", "0.1")
    assert watcher._interval_seconds() == watcher.MIN_INTERVAL_MINUTES * 60
    monkeypatch.setenv("STOX_MONITOR_INTERVAL_MIN", "junk")
    assert watcher._interval_seconds() == watcher.DEFAULT_INTERVAL_MINUTES * 60


def test_send_test_message_exit_codes(monkeypatch, capsys):
    monkeypatch.setattr(watcher.config, "load_env", lambda: None)
    with patch("stoxlib.watcher.notify.send_whatsapp") as send:
        watcher.send_test_message()
    send.assert_called_once()

    with patch("stoxlib.watcher.notify.send_whatsapp", side_effect=NotifyError("bad key")):
        with pytest.raises(SystemExit) as exit_info:
            watcher.send_test_message()
    assert exit_info.value.code == 1
    assert "bad key" in capsys.readouterr().err
