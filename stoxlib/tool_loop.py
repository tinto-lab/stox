"""Shared LLM tool-calling loop used by the main agent and the analysis
specialists.

Both run the same skeleton: bind tools, invoke the model, and if it didn't
call any tools return its text -- otherwise run each tool call through the
caller's `dispatch`, append a ToolMessage per result, and go again. They
differ only in how many rounds they're willing to spend: the main agent
loops without limit (a real conversation, with an operator watching via
on_tool_call), while a specialist has a fixed round budget and forces one
final tools-unbound call if that budget runs out, so a model that spent
every round on tool calls still produces a real answer instead of a
placeholder standing in for one.
"""

from langchain_core.messages import HumanMessage, ToolMessage


def run_tool_loop(llm, messages, tools, dispatch, on_tool_call=None,
                   max_rounds=None, budget_exhausted_notice=None):
    """Run the bind-invoke-dispatch loop, extending `messages` in place
    (it must already hold the system/user messages to start from), and
    return the model's final text.

    `dispatch(name, args) -> result_text` runs one tool call; `on_tool_call`,
    if given, is called as `on_tool_call(name, args)` right before dispatch.

    With `max_rounds=None` (the default) the loop runs until the model
    stops calling tools. With `max_rounds` set, the loop gives up after
    that many LLM invocations, appends `budget_exhausted_notice` as a
    HumanMessage, and makes one last call with no tools bound so the model
    must write up whatever it already gathered.
    """
    llm_with_tools = llm.bind_tools(tools)
    rounds = 0

    while max_rounds is None or rounds < max_rounds:
        rounds += 1
        ai_msg = llm_with_tools.invoke(messages)
        messages.append(ai_msg)

        if not ai_msg.tool_calls:
            return ai_msg.content if isinstance(ai_msg.content, str) else str(ai_msg.content)

        for call in ai_msg.tool_calls:
            if on_tool_call is not None:
                on_tool_call(call["name"], call["args"])
            result_text = dispatch(call["name"], call["args"])
            messages.append(ToolMessage(content=result_text, tool_call_id=call["id"]))

    messages.append(HumanMessage(content=budget_exhausted_notice))
    final_msg = llm.invoke(messages)
    return final_msg.content if isinstance(final_msg.content, str) else str(final_msg.content)
