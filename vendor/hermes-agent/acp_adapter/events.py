"""Callback factories for bridging AIAgent events to ACP notifications.

Each factory returns a callable with the signature that AIAgent expects
for its callbacks. Internally, the callbacks push ACP session updates
to the client via ``conn.session_update()`` using
``asyncio.run_coroutine_threadsafe()`` (since AIAgent runs in a worker
thread while the event loop lives on the main thread).
"""

import asyncio
import json
import logging
from collections import deque
from typing import Any, Callable, Deque, Dict

import acp
from acp.schema import AgentPlanUpdate, PlanEntry

from .tools import (
    build_tool_complete,
    build_tool_start,
    make_tool_call_id,
    get_tool_kind,
)

logger = logging.getLogger(__name__)


def _json_loads_maybe_prefix(value: str) -> Any:
    """Parse a JSON object even when Hermes appended a human hint after it."""
    text = value.strip()
    try:
        return json.loads(text)
    except Exception:
        decoder = json.JSONDecoder()
        data, _ = decoder.raw_decode(text)
        return data


def _build_plan_update_from_todo_result(result: Any) -> AgentPlanUpdate | None:
    """Translate Hermes' todo tool result into ACP's native plan update.

    Zed renders ``sessionUpdate: plan`` as its first-class task/todo panel. The
    Hermes agent already maintains task state through the ``todo`` tool, so the
    ACP adapter should expose that state natively instead of only as a generic
    tool-call transcript block.
    """
    if not isinstance(result, str) or not result.strip():
        return None

    try:
        data = _json_loads_maybe_prefix(result)
    except Exception:
        return None

    if not isinstance(data, dict) or not isinstance(data.get("todos"), list):
        return None

    todos = data["todos"]
    if not todos:
        return AgentPlanUpdate(session_update="plan", entries=[])

    status_map = {
        "pending": "pending",
        "in_progress": "in_progress",
        "completed": "completed",
        # ACP plans only support pending/in_progress/completed. Preserve
        # cancelled tasks as terminal entries instead of dropping them and
        # making the client's full-list replacement lose visible context.
        "cancelled": "completed",
    }
    entries: list[PlanEntry] = []
    for item in todos:
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or item.get("id") or "").strip()
        if not content:
            continue
        raw_status = str(item.get("status") or "pending").strip()
        status = status_map.get(raw_status, "pending")
        if raw_status == "cancelled":
            content = f"[cancelled] {content}"
        entries.append(PlanEntry(content=content, priority="medium", status=status))

    return AgentPlanUpdate(session_update="plan", entries=entries)


def _send_update(
    conn: acp.Client,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
    update: Any,
) -> None:
    """Fire-and-forget an ACP session update from a worker thread."""
    from agent.async_utils import safe_schedule_threadsafe

    future = safe_schedule_threadsafe(
        conn.session_update(session_id, update),
        loop,
        logger=logger,
        log_message="Failed to send ACP update",
    )
    if future is None:
        return
    try:
        future.result(timeout=5)
    except Exception:
        logger.debug("Failed to send ACP update", exc_info=True)


# ------------------------------------------------------------------
# Tool progress callback
# ------------------------------------------------------------------

def make_tool_progress_cb(
    conn: acp.Client,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
    tool_call_ids: Dict[str, Deque[str]],
    tool_call_meta: Dict[str, Dict[str, Any]],
    edit_approval_policy_getter: Callable[[], tuple[str, str | None]] | None = None,
) -> Callable:
    """Create a ``tool_progress_callback`` for AIAgent.

    Signature expected by AIAgent::

        tool_progress_callback(event_type: str, name: str, preview: str, args: dict, **kwargs)

    Emits ``ToolCallStart`` for ``tool.started`` events and tracks IDs in a FIFO
    queue per tool name so duplicate/parallel same-name calls still complete
    against the correct ACP tool call.  Sub-agent events (``subagent.*``,
    ``delegate.*``) are emitted as nested ``ToolCallStart``/``ToolCallProgress``
    so the ACP client can render a sub-agent tree.
    """

    def _handle_subagent_event(event_type: str, name: str = None, preview: str = None, args: Any = None, **kwargs: Any) -> None:
        """Emit sub-agent progress as ACP events with delegation metadata."""
        delegation_id = kwargs.get("_subagent_delegation_id", "")
        task_index = kwargs.get("_subagent_task_index", 0)
        goal = kwargs.get("_subagent_goal", "")

        # Build a stable sub-agent tool_call_id prefix for this delegation
        sa_prefix = f"sa-{delegation_id}-{task_index}"

        if event_type in ("subagent.start", "delegate.task_started"):
            # Emit a ToolCallStart for the sub-agent itself
            tc_id = f"{sa_prefix}-root"
            title = f"SubAgent: {goal}" if goal else "SubAgent"
            update = acp.start_tool_call(
                tc_id, title, kind="execute",
                content=[acp.tool_content(acp.text_block(f"Sub-agent started: {goal}"))] if goal else None,
            )
            _send_update(conn, session_id, loop, update)

        elif event_type in ("subagent.tool",):
            # Emit a nested ToolCallStart for the child's tool call
            tool_name = name or "tool"
            tc_id = f"{sa_prefix}-tool-{make_tool_call_id()}"
            title = f"{tool_name}: {preview}" if preview else tool_name
            # Store for later completion
            queue = tool_call_ids.get(f"__sa_{sa_prefix}")
            if queue is None:
                queue = deque()
                tool_call_ids[f"__sa_{sa_prefix}"] = queue
            queue.append(tc_id)
            tool_call_meta[tc_id] = {"args": args if isinstance(args, dict) else {}}
            kind = get_tool_kind(tool_name)
            update = acp.start_tool_call(tc_id, title, kind=kind)
            _send_update(conn, session_id, loop, update)

        elif event_type in ("subagent.complete", "delegate.task_completed"):
            # Emit ToolCallProgress to close the sub-agent root
            tc_id = f"{sa_prefix}-root"
            status = kwargs.get("status", "completed")
            summary = preview or ""
            content = [acp.tool_content(acp.text_block(summary))] if summary else None
            update = acp.update_tool_call(tc_id, status=status, content=content)
            _send_update(conn, session_id, loop, update)

        elif event_type in ("subagent.text",):
            # Streamed text from child — relay as agent_message_chunk
            # so the gateway watch window can mirror the child's reply.
            if preview:
                update = acp.update_agent_message_text(preview)
                _send_update(conn, session_id, loop, update)

        elif event_type in ("subagent.thinking", "delegate.task_thinking"):
            # Relay child reasoning as a thought chunk
            if preview:
                update = acp.update_agent_thought_text(preview)
                _send_update(conn, session_id, loop, update)

        # "subagent.progress" and "delegate.task_progress" are batched
        # summaries — no need to emit individually; the tool_call
        # completion carries the full summary.

    def _tool_progress(event_type: str, name: str = None, preview: str = None, args: Any = None, **kwargs) -> None:
        # Handle subagent/delegate events
        if isinstance(event_type, str) and (
            event_type.startswith("subagent.") or event_type.startswith("delegate.")
        ):
            try:
                _handle_subagent_event(event_type, name, preview, args, **kwargs)
            except Exception:
                logger.debug("Failed to handle subagent event %s", event_type, exc_info=True)
            return

        # Only emit ACP ToolCallStart for tool.started; ignore other event types
        if event_type == "tool.output_delta":
            # Streaming output chunk from a running tool (e.g. terminal command).
            # Forward as an incremental ToolCallProgress with "in_progress" status.
            if isinstance(args, str):
                chunk = args
            else:
                chunk = preview or ""
            if not chunk:
                return
            # Look up the tool call ID for this tool name (most recent in queue)
            queue = tool_call_ids.get(name)
            if queue is None:
                return
            tc_id = queue[-1] if isinstance(queue, deque) else queue
            if not tc_id:
                return
            try:
                content = [acp.tool_content(acp.text_block(chunk))]
                update = acp.update_tool_call(tc_id, status="in_progress", content=content)
                _send_update(conn, session_id, loop, update)
            except Exception:
                logger.debug("Failed to send tool.output_delta for %s", name, exc_info=True)
            return
        if event_type != "tool.started":
            return
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (json.JSONDecodeError, TypeError):
                args = {"raw": args}
        if not isinstance(args, dict):
            args = {}

        tc_id = make_tool_call_id()
        queue = tool_call_ids.get(name)
        if queue is None:
            queue = deque()
            tool_call_ids[name] = queue
        elif isinstance(queue, str):
            queue = deque([queue])
            tool_call_ids[name] = queue
        queue.append(tc_id)

        snapshot = None
        if name in {"write_file", "patch", "skill_manage"}:
            try:
                from agent.display import capture_local_edit_snapshot

                snapshot = capture_local_edit_snapshot(name, args)
            except Exception:
                logger.debug("Failed to capture ACP edit snapshot for %s", name, exc_info=True)
        tool_call_meta[tc_id] = {"args": args, "snapshot": snapshot}

        edit_diff = None
        if name in {"write_file", "patch"} and edit_approval_policy_getter is not None:
            try:
                from acp_adapter.edit_approval import build_edit_proposal, should_auto_approve_edit

                proposal = build_edit_proposal(name, args)
                if proposal is not None:
                    policy, cwd = edit_approval_policy_getter()
                    if should_auto_approve_edit(proposal, policy, cwd):
                        edit_diff = proposal
            except Exception:
                logger.debug("Failed to prepare auto-approved ACP edit diff for %s", name, exc_info=True)

        update = build_tool_start(tc_id, name, args, edit_diff=edit_diff)
        _send_update(conn, session_id, loop, update)

    return _tool_progress


# ------------------------------------------------------------------
# Thinking callback
# ------------------------------------------------------------------

def make_thinking_cb(
    conn: acp.Client,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
) -> Callable:
    """Create a ``thinking_callback`` for AIAgent."""

    def _thinking(text: str) -> None:
        if not text:
            return
        update = acp.update_agent_thought_text(text)
        _send_update(conn, session_id, loop, update)

    return _thinking


# ------------------------------------------------------------------
# Step callback
# ------------------------------------------------------------------

def make_step_cb(
    conn: acp.Client,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
    tool_call_ids: Dict[str, Deque[str]],
    tool_call_meta: Dict[str, Dict[str, Any]],
) -> Callable:
    """Create a ``step_callback`` for AIAgent.

    Signature expected by AIAgent::

        step_callback(api_call_count: int, prev_tools: list)
    """

    def _step(api_call_count: int, prev_tools: Any = None) -> None:
        if prev_tools and isinstance(prev_tools, list):
            for tool_info in prev_tools:
                tool_name = None
                result = None
                function_args = None

                if isinstance(tool_info, dict):
                    tool_name = tool_info.get("name") or tool_info.get("function_name")
                    result = tool_info.get("result") or tool_info.get("output")
                    function_args = tool_info.get("arguments") or tool_info.get("args")
                elif isinstance(tool_info, str):
                    tool_name = tool_info

                queue = tool_call_ids.get(tool_name or "")
                if isinstance(queue, str):
                    queue = deque([queue])
                    tool_call_ids[tool_name] = queue
                if tool_name and queue:
                    tc_id = queue.popleft()
                    meta = tool_call_meta.pop(tc_id, {})
                    update = build_tool_complete(
                        tc_id,
                        tool_name,
                        result=str(result) if result is not None else None,
                        function_args=function_args or meta.get("args"),
                        snapshot=meta.get("snapshot"),
                    )
                    _send_update(conn, session_id, loop, update)
                    if tool_name == "todo":
                        plan_update = _build_plan_update_from_todo_result(result)
                        if plan_update is not None:
                            _send_update(conn, session_id, loop, plan_update)
                    if not queue:
                        tool_call_ids.pop(tool_name, None)

    return _step


# ------------------------------------------------------------------
# Agent message callback
# ------------------------------------------------------------------

def make_message_cb(
    conn: acp.Client,
    session_id: str,
    loop: asyncio.AbstractEventLoop,
) -> Callable:
    """Create a callback that streams agent response text to the editor."""

    def _message(text: str) -> None:
        if not text:
            return
        update = acp.update_agent_message_text(text)
        _send_update(conn, session_id, loop, update)

    return _message
