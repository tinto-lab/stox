"""stoxlib — implementation package for the stox terminal console.

Each module owns one responsibility, so a change to one has no reason to
touch the others:

    quotes.py      the EODHD data source (Quote, fetch_quotes)
    news.py        the EODHD news data source (Article, fetch_news)
    rendering.py   turns Quotes/Articles into rich console output
    providers.py   LLM provider registry (Anthropic / DeepSeek / OpenAI / ...)
    agent.py       natural-language question handling via LangChain tool use
    shell.py       the REPL: routes input, owns the Console, wires it together

See stox.py at the project root for the entry point.
"""
