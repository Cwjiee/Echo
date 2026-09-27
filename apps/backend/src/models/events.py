"""Pydantic models for WebSocket events, webhook payloads, and AI agent responses."""

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Webhook / inbound
# ---------------------------------------------------------------------------


class GitHubWebhookPayload(BaseModel):
    event_type: str
    payload: dict[str, Any]


# ---------------------------------------------------------------------------
# AI Agent — Phase 2 response models
# ---------------------------------------------------------------------------


class ConflictInfo(BaseModel):
    """Output of the conflict detection stage."""

    has_conflict: bool
    confidence: float = Field(ge=0.0, le=1.0)
    conflict_type: Literal["none", "merge", "dependency", "schema", "logic"]
    affected_files: list[str] = []
    description: str


class ResolutionInfo(BaseModel):
    """Executable resolution produced by the AI agent."""

    steps: list[str]
    actions: list[str]  # e.g. ["git_fetch", "git_pull", "run_tests"]


class AnalysisResult(BaseModel):
    """
    Standardised payload returned by analyze_payload() and broadcast
    over WebSocket to Mac agents and the ChatOps bot.
    """

    action_id: str
    event_type: str
    summary: str
    severity: Literal["info", "warning", "critical"]
    requires_approval: bool
    conflict: ConflictInfo
    resolution: ResolutionInfo
    context: dict[str, Any] = {}


# ---------------------------------------------------------------------------
# Resolution approval flow
# ---------------------------------------------------------------------------


class ApprovedResolution(BaseModel):
    """
    Sent by the backend to the Mac agent after the developer approves
    a resolution in Discord/Slack.
    """

    action_id: str
    workspace: str
    actions: list[str]
    context: dict[str, Any] = {}


class ApprovalResponse(BaseModel):
    """
    Sent by the Mac agent back to the backend after executing a resolution.
    """

    action_id: str
    success: bool
    output: str
    test_results: dict[str, Any] | None = None
