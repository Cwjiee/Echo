"""
Socket.IO WebSocket Manager.

Manages:
  - Authenticated connections from Mac agents
  - Room-based event broadcasting (per developer / workspace)
  - Approval payload relay from the bot to the Mac agent
  - Execution result relay from the Mac agent back to the bot
"""

from __future__ import annotations

import logging
from typing import Any

import socketio

from src.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------
# AsyncServer so all handlers are coroutines — compatible with FastAPI.

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # Tighten in production
    logger=False,
    engineio_logger=False,
)

# sid → developer metadata
_connected_agents: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Connection lifecycle events
# ---------------------------------------------------------------------------


@sio.event
async def connect(sid: str, environ: dict[str, Any], auth: dict[str, Any] | None = None) -> bool:
    """
    Called when a Mac agent connects.

    auth = { "token": "<agent-auth-token>", "workspace": "my-project" }

    The token is validated against the AGENT_AUTH_TOKENS env var.
    When AGENT_AUTH_TOKENS is empty (local dev), all tokens are accepted.
    """
    settings = get_settings()
    token = (auth or {}).get("token", "")
    workspace = (auth or {}).get("workspace", "default")

    if not token:
        logger.warning("[ws] Rejected unauthenticated connection: sid=%s", sid)
        return False  # Reject connection

    valid_tokens = settings.valid_agent_tokens
    if valid_tokens and token not in valid_tokens:
        logger.warning("[ws] Rejected connection with invalid token: sid=%s", sid)
        return False

    _connected_agents[sid] = {"workspace": workspace, "token": token}
    await sio.enter_room(sid, workspace)  # Group agents by workspace
    logger.info("[ws] Agent connected: sid=%s workspace=%s", sid, workspace)
    await sio.emit("connected", {"message": "Echo agent connected", "sid": sid}, to=sid)
    return True


@sio.event
async def disconnect(sid: str) -> None:
    agent = _connected_agents.pop(sid, {})
    logger.info("[ws] Agent disconnected: sid=%s was=%s", sid, agent)


# ---------------------------------------------------------------------------
# Client → Server events
# ---------------------------------------------------------------------------


@sio.event
async def approval_response(sid: str, data: dict[str, Any]) -> None:
    """
    Mac agent reports back the result of executing an approved resolution.

    data = { "action_id": "...", "success": true, "output": "..." }

    Flow: Mac agent → backend (here) → update state → notify bot channel.
    """
    action_id = data.get("action_id", "")
    success = bool(data.get("success", False))
    output = str(data.get("output", ""))

    logger.info(
        "[ws] Execution result from sid=%s action_id=%s success=%s",
        sid,
        action_id,
        success,
    )

    # Update state and build the bot notification
    from src.services.orchestrator import handle_execution_result  # avoid import cycle

    action = await handle_execution_result(action_id, success, output)
    if action:
        # Emit an execution_result event so the bot can update the Discord message
        await sio.emit(
            "execution_result",
            {
                "action_id": action_id,
                "success": success,
                "output": output,
                "repository": action.repository,
                "workspace": action.workspace,
            },
        )


# ---------------------------------------------------------------------------
# Server → Client broadcast helpers
# ---------------------------------------------------------------------------


async def broadcast_event(event_name: str, data: dict[str, Any], room: str = "/") -> None:
    """Broadcast an event to all connected agents (or a specific room)."""
    if room == "/":
        await sio.emit(event_name, data)
    else:
        await sio.emit(event_name, data, room=room)


async def send_approved_resolution(
    workspace: str,
    action_id: str,
    actions: list[str],
    context: dict[str, Any],
) -> None:
    """
    Send an approved resolution payload to all agents in a workspace room.

    Payload shape the Mac agent / local-executor expects:
    {
        "action_id": "<uuid>",
        "actions": ["git_fetch", "git_pull", "npm_install"],
        "context": { ... }
    }
    """
    payload = {"action_id": action_id, "actions": actions, "context": context}
    await sio.emit("approved_resolution", payload, room=workspace)
    logger.info("[ws] Sent approved_resolution to room='%s': action_id=%s", workspace, action_id)


# ---------------------------------------------------------------------------
# Inspection helpers (used by the admin route)
# ---------------------------------------------------------------------------


def get_connected_agents() -> dict[str, dict]:
    """Return a snapshot of currently connected agents."""
    return dict(_connected_agents)


def get_agent_count() -> int:
    return len(_connected_agents)
