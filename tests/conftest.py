"""Shared test fixtures.

Both fixtures are autouse: they strip every env var stox reads (API keys,
provider selection) and redirect the on-disk considerations file to a
throwaway path, before each test -- so a developer's own shell exports or
a real ~/.config/stox/considerations.txt can never leak into a test and
make it pass or fail depending on who's running it.
"""

import pytest

from stoxlib import considerations

_STOX_ENV_VARS = [
    "EODHD_API_KEY",
    "WEBZ_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "STOX_LLM_PROVIDER",
    "STOX_LLM_MODEL",
]


@pytest.fixture(autouse=True)
def clean_stox_env(monkeypatch):
    for var in _STOX_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture(autouse=True)
def isolate_considerations_file(tmp_path, monkeypatch):
    monkeypatch.setattr(considerations, "CONSIDERATIONS_FILE", tmp_path / "considerations.txt")
