"""Pydantic models for WebSocket events and webhook payloads."""

from typing import Any

from pydantic import BaseModel


class GitHubWebhookPayload(BaseModel):
    event_type: str
    payload: dict[str, Any]


class ApprovedResolution(BaseModel):
    action_id: str
    workspace: str
    actions: list[str]
    context: dict[str, Any]


class ApprovalResponse(BaseModel):
    action_id: str
    success: bool
    output: str
