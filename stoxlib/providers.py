"""LLM provider registry: turns STOX_LLM_PROVIDER into a bound chat model.

Adding a provider means adding one entry to LLM_PROVIDERS -- agent.py never
changes, since it only depends on build_llm()'s return value (a LangChain
chat model), never on a specific provider.
"""

import importlib
import os

LLM_PROVIDERS = {
    "anthropic": {
        "package": "langchain_anthropic",
        "class": "ChatAnthropic",
        "default_model": "claude-opus-5",
        "api_key_env": "ANTHROPIC_API_KEY",
    },
    "deepseek": {
        "package": "langchain_deepseek",
        "class": "ChatDeepSeek",
        "default_model": "deepseek-chat",
        "api_key_env": "DEEPSEEK_API_KEY",
    },
    "openai": {
        "package": "langchain_openai",
        "class": "ChatOpenAI",
        "default_model": "gpt-4o-mini",
        "api_key_env": "OPENAI_API_KEY",
    },
}


class AgentError(Exception):
    """Raised when the configured LLM provider can't be used."""


def current_provider_name():
    return os.environ.get("STOX_LLM_PROVIDER", "anthropic").lower()


def describe_current():
    """'<provider>/<model>' for whatever's currently configured -- safe to
    display even if the provider is unknown or its package/key is missing.
    """
    provider = current_provider_name()
    cfg = LLM_PROVIDERS.get(provider)
    if cfg is None:
        return provider
    model = os.environ.get("STOX_LLM_MODEL", cfg["default_model"])
    return "%s/%s" % (provider, model)


def build_llm():
    """Build a chat model from STOX_LLM_PROVIDER / STOX_LLM_MODEL env vars."""
    provider = current_provider_name()
    cfg = LLM_PROVIDERS.get(provider)
    if cfg is None:
        raise AgentError(
            "unknown STOX_LLM_PROVIDER '%s' -- choose from: %s"
            % (provider, ", ".join(LLM_PROVIDERS))
        )
    if not os.environ.get(cfg["api_key_env"]):
        raise AgentError(
            "no %s set for provider '%s' -- see /help"
            % (cfg["api_key_env"], provider)
        )
    try:
        module = importlib.import_module(cfg["package"])
    except ImportError as e:
        raise AgentError(
            "provider '%s' needs its LangChain package -- pip install %s"
            % (provider, cfg["package"].replace("_", "-"))
        ) from e

    model_cls = getattr(module, cfg["class"])
    model = os.environ.get("STOX_LLM_MODEL", cfg["default_model"])
    return model_cls(model=model)
