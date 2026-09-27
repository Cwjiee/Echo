"""
Admin / introspection endpoints.

These routes allow operators (and integration tests) to inspect the live
state of the backend without connecting a Socket.IO client.

Endpoints
---------
GET  /api/admin/status          — Overall health + connected-agent count
GET  /api/admin/agents          — List connected Mac agents
GET  /api/admin/repos           — List known repositories
GET  /api/admin/actions         — List pending actions (optionally filtered by workspace)
GET  /api/admin/actions/{id}    — Get a single pending action
POST /api/admin/approve/{id}    — Programmatically approve an action (for testing)
POST /api/admin/dismiss/{id}    — Programmatically dismiss an action
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status

from src.services.orchestrator import handle_approval, handle_dismissal
from src.services.state_manager import get_state_manager
from src.websocket.manager import get_agent_count, get_connected_agents

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------


@router.get("/status")
async def admin_status() -> dict:
    """Overall backend status snapshot."""
    state = get_state_manager()
    return {
        "connected_agents": get_agent_count(),
        "known_repos": len(state.list_repos()),
        "pending_actions": len(state.list_pending_actions()),
    }


# ---------------------------------------------------------------------------
# Connected agents
# ---------------------------------------------------------------------------


@router.get("/agents")
async def list_agents() -> dict:
    """Return all currently connected Mac agents (sid → metadata)."""
    agents = get_connected_agents()
    # Mask tokens for security
    sanitised = {
        sid: {"workspace": meta.get("workspace"), "token_prefix": meta.get("token", "")[:6] + "…"}
        for sid, meta in agents.items()
    }
    return {"count": len(sanitised), "agents": sanitised}


# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------


@router.get("/repos")
async def list_repos() -> dict:
    """Return all repositories the backend knows about."""
    state = get_state_manager()
    return {"repos": [r.to_dict() for r in state.list_repos()]}


# ---------------------------------------------------------------------------
# Pending actions
# ---------------------------------------------------------------------------


@router.get("/actions")
async def list_actions(
    workspace: str | None = Query(None, description="Filter by workspace"),
) -> dict:
    """Return pending actions, optionally filtered by workspace."""
    state = get_state_manager()
    actions = state.list_pending_actions(workspace=workspace)
    return {"count": len(actions), "actions": [a.to_dict() for a in actions]}


@router.get("/actions/{action_id}")
async def get_action(action_id: str) -> dict:
    """Return a single pending action by ID."""
    state = get_state_manager()
    action = state.get_pending_action(action_id)
    if not action:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Action '{action_id}' not found",
        )
    return action.to_dict()


# ---------------------------------------------------------------------------
# Approval / dismissal (useful for integration testing)
# ---------------------------------------------------------------------------


@router.post("/approve/{action_id}", status_code=status.HTTP_200_OK)
async def approve_action(
    action_id: str,
    workspace: str = Query(..., description="Target workspace room"),
    approved_by: str = Query("admin", description="Who triggered the approval"),
) -> dict:
    """Programmatically approve an action and dispatch it to the Mac agent."""
    dispatched = await handle_approval(action_id, workspace, approved_by=approved_by)
    if not dispatched:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Action '{action_id}' not found or already resolved",
        )
    return {"approved": True, "action_id": action_id, "workspace": workspace}


@router.post("/dismiss/{action_id}", status_code=status.HTTP_200_OK)
async def dismiss_action(action_id: str) -> dict:
    """Programmatically dismiss (reject) a pending action."""
    dismissed = await handle_dismissal(action_id)
    if not dismissed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Action '{action_id}' not found or already resolved",
        )
    return {"dismissed": True, "action_id": action_id}
