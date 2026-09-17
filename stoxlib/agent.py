"""Natural-language question handling.

Resolves a plain-English question ("what's apple trading at today?") into
tool calls against the quote data source via LangChain tool use. Returns
data (AgentResult), never prints -- shell.py owns all console output, so
this module has no UI dependency and no reason to change when the console
formatting does.
"""

from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from .providers import AgentError, build_llm
from .quotes import QuoteError, fetch_quotes

AGENT_SYSTEM = (
    "You are stox, a terse terminal stock-quote assistant. When the user asks "
    "about a price, quote, or how a stock/crypto/FX pair is doing, call "
    "get_stock_quote with the right ticker symbol(s) -- translate company names "
    "to tickers yourself (Apple -> AAPL, Tesla -> TSLA, Microsoft -> MSFT, ...). "
    "Answer in one short sentence using the numbers the tool returns. Don't "
    "repeat the raw tool output verbatim and don't restate a full table -- a "
    "detailed quote panel is printed to the console right after your answer."
)


@dataclass
class AgentResult:
    text: str = ""
    quotes: list = field(default_factory=list)
    error: str | None = None


def run_quote_tool(tickers):
    """Fetch quotes and render them as tool-result text; also return the Quotes."""
    try:
        quotes, missing = fetch_quotes(tickers)
    except QuoteError as e:
        return "error: %s" % e, []

    lines = [
        "%s: price=%.2f change=%+.2f change_pct=%+.2f%% open=%.2f high=%.2f "
        "low=%.2f prev_close=%.2f volume=%.0f" % (
            q.code, q.price, q.change, q.percent, q.open, q.high, q.low,
            q.prev_close, q.volume,
        )
        for q in quotes
    ]
    lines += ["%s: no data (unknown symbol?)" % code for code in missing]
    return "\n".join(lines) or "no data", quotes


@tool
def get_stock_quote(tickers: list[str]) -> str:
    """Look up real-time price quotes for one or more tickers via EODHD.

    Bare symbols default to the US exchange (AAPL, TSLA). Use
    SYMBOL.EXCHANGE for anything else (BMW.XETRA, BTC-USD.CC, EURUSD.FOREX).
    """
    text, _ = run_quote_tool(tickers)
    return text


def ask_agent(query, llm=None):
    """Resolve a natural-language query into an AgentResult.

    `llm` is injectable (tests can pass a fake chat model); by default it's
    built from the configured provider.
    """
    if llm is None:
        try:
            llm = build_llm()
        except AgentError as e:
            return AgentResult(error=str(e))

    llm_with_tools = llm.bind_tools([get_stock_quote])
    messages = [SystemMessage(content=AGENT_SYSTEM), HumanMessage(content=query)]
    last_quotes = []

    try:
        while True:
            ai_msg = llm_with_tools.invoke(messages)
            messages.append(ai_msg)

            if not ai_msg.tool_calls:
                text = ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content)
                return AgentResult(text=text, quotes=last_quotes)

            for call in ai_msg.tool_calls:
                if call["name"] == "get_stock_quote":
                    result_text, quotes = run_quote_tool(call["args"].get("tickers", []))
                    last_quotes = quotes or last_quotes
                else:
                    result_text = "unknown tool"
                messages.append(ToolMessage(content=result_text, tool_call_id=call["id"]))
    except Exception as e:
        return AgentResult(error="agent error: %s" % e)
