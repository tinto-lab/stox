"""Shared test fixtures.

All fixtures are autouse: they strip every env var stox reads (API keys,
provider selection) and redirect the on-disk considerations and news
monitor files to throwaway paths, before each test -- so a developer's own
shell exports or real files under ~/.config/stox/ can never leak into a
test (or be written by one) and make it pass or fail depending on who's
running it.
"""

import pytest

from stoxlib import considerations, monitors

_STOX_ENV_VARS = [
    "EODHD_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "STOX_LLM_PROVIDER",
    "STOX_LLM_MODEL",
    "STOX_MONITOR_INTERVAL_MIN",
    "CALLMEBOT_PHONE",
    "CALLMEBOT_APIKEY",
]


@pytest.fixture(autouse=True)
def clean_stox_env(monkeypatch):
    for var in _STOX_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture(autouse=True)
def isolate_considerations_file(tmp_path, monkeypatch):
    monkeypatch.setattr(considerations, "CONSIDERATIONS_FILE", tmp_path / "considerations.txt")


@pytest.fixture(autouse=True)
def isolate_monitor_files(tmp_path, monkeypatch):
    monkeypatch.setattr(monitors, "MONITORS_FILE", tmp_path / "monitors.json")
    monkeypatch.setattr(monitors, "STATE_FILE", tmp_path / "monitor_state.json")
    monkeypatch.setattr(monitors, "ALERTS_FILE", tmp_path / "alerts.jsonl")
