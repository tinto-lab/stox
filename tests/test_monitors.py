import json

import pytest

from stoxlib import monitors


def test_no_file_means_no_monitors():
    assert monitors.load_monitors() == []
    assert monitors.load_alerts() == []
    assert monitors.load_state() == {}


def test_add_monitor_cleans_input_and_persists():
    m = monitors.add_monitor("  oil up  ", ["Iran", " ", "OPEC output "], ["uso", "", "xom"])

    assert m["goal"] == "oil up"
    assert m["queries"] == ["Iran", "OPEC output"]
    assert m["tickers"] == ["USO", "XOM"]
    assert monitors.load_monitors() == [m]


def test_add_monitor_needs_a_query():
    with pytest.raises(ValueError):
        monitors.add_monitor("oil", [" ", ""], [])
    assert monitors.load_monitors() == []


def test_goal_falls_back_to_first_query():
    assert monitors.add_monitor("", ["Iran"], [])["goal"] == "Iran"


def test_remove_monitor():
    a = monitors.add_monitor("a", ["x"], [])
    b = monitors.add_monitor("b", ["y"], [])

    assert monitors.remove_monitor(a["id"]) is True
    assert monitors.remove_monitor("nope") is False
    assert monitors.load_monitors() == [b]


def test_corrupt_monitors_file_reads_as_empty():
    monitors.MONITORS_FILE.write_text("{not json")
    assert monitors.load_monitors() == []


def test_save_state_caps_and_drops_deleted_monitors(monkeypatch):
    monkeypatch.setattr(monitors, "MAX_SEEN_PER_MONITOR", 2)
    monitors.save_state({"a": ["1", "2", "3"], "gone": ["x"]}, {"a"})
    assert monitors.load_state() == {"a": ["2", "3"]}


def test_alerts_come_back_newest_first_and_limited():
    for i in range(5):
        monitors.append_alert({"n": i})
    with monitors.ALERTS_FILE.open("a") as f:
        f.write("garbage\n")

    assert [a["n"] for a in monitors.load_alerts(limit=3)] == [4, 3, 2]


def test_writes_leave_no_temp_file():
    monitors.add_monitor("a", ["x"], [])
    assert json.loads(monitors.MONITORS_FILE.read_text())["monitors"][0]["goal"] == "a"
    assert not monitors.MONITORS_FILE.with_name("monitors.json.tmp").exists()
