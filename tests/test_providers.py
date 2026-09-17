import sys
import types

import pytest

from stoxlib import providers


def test_current_provider_name_defaults_to_anthropic():
    assert providers.current_provider_name() == "anthropic"


def test_current_provider_name_reads_env_lowercased(monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "DeepSeek")
    assert providers.current_provider_name() == "deepseek"


def test_describe_current_uses_default_model():
    assert providers.describe_current() == "anthropic/claude-opus-5"


def test_describe_current_respects_model_override(monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("STOX_LLM_MODEL", "deepseek-reasoner")
    assert providers.describe_current() == "deepseek/deepseek-reasoner"


def test_describe_current_handles_unknown_provider(monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "bogus")
    assert providers.describe_current() == "bogus"


def test_build_llm_rejects_unknown_provider(monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "bogus")
    with pytest.raises(providers.AgentError, match="unknown STOX_LLM_PROVIDER"):
        providers.build_llm()


def test_build_llm_requires_api_key(monkeypatch):
    monkeypatch.setenv("STOX_LLM_PROVIDER", "deepseek")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(providers.AgentError, match="DEEPSEEK_API_KEY"):
        providers.build_llm()


def test_build_llm_reports_missing_package(monkeypatch):
    monkeypatch.setitem(providers.LLM_PROVIDERS, "fake", {
        "package": "definitely_not_a_real_package",
        "class": "ChatFake",
        "default_model": "fake-model",
        "api_key_env": "FAKE_API_KEY",
    })
    monkeypatch.setenv("STOX_LLM_PROVIDER", "fake")
    monkeypatch.setenv("FAKE_API_KEY", "x")
    with pytest.raises(providers.AgentError, match="pip install definitely-not-a-real-package"):
        providers.build_llm()


def test_build_llm_constructs_model_with_resolved_model_name(monkeypatch):
    fake_module = types.ModuleType("fake_llm_package")

    class FakeChatModel:
        def __init__(self, model):
            self.model = model

    fake_module.FakeChatModel = FakeChatModel
    monkeypatch.setitem(sys.modules, "fake_llm_package", fake_module)
    monkeypatch.setitem(providers.LLM_PROVIDERS, "fake", {
        "package": "fake_llm_package",
        "class": "FakeChatModel",
        "default_model": "fake-default",
        "api_key_env": "FAKE_API_KEY",
    })
    monkeypatch.setenv("STOX_LLM_PROVIDER", "fake")
    monkeypatch.setenv("FAKE_API_KEY", "x")

    llm = providers.build_llm()
    assert isinstance(llm, FakeChatModel)
    assert llm.model == "fake-default"

    monkeypatch.setenv("STOX_LLM_MODEL", "fake-override")
    llm = providers.build_llm()
    assert llm.model == "fake-override"
