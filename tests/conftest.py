"""Shared test fixtures.

The most important one is autouse: it strips every env var stox reads
(API keys, provider selection) before each test, so a developer's own
shell exports (a real ANTHROPIC_API_KEY, say) can never leak into a test
and make it pass or fail depending on who's running it.
"""

import pytest

_STOX_ENV_VARS = [
    "EODHD_API_KEY",
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
