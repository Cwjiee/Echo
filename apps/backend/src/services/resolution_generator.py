"""
Resolution proposal generator.

Takes a ConflictReport and the upstream diff and asks the watsonx.ai LLM
to generate:

  1. A human-readable summary of what changed upstream.
  2. A concrete step-by-step resolution plan.
  3. A machine-executable actions list that the Local Execution Engine
     (Phase 5, packages/local-executor) understands.

Supported action tokens (consumed by the local executor):
  git_fetch          — git fetch --all
  git_pull           — git pull (fast-forward only)
  git_merge_upstream — merge upstream/<branch> into current branch
  git_rebase         — rebase current branch onto upstream
  npm_install        — npm install (re-install node_modules)
  pip_install        — pip install -r requirements.txt
  run_migrations     — run database migrations
  run_tests          — run the project test suite
  manual_review      — flag for human review (no automatic action)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from src.services.conflict_detector import ConflictReport
from src.services.groq_client import get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Supported executable actions (allow-list for security)
# ---------------------------------------------------------------------------

VALID_ACTIONS: set[str] = {
    "git_fetch",
    "git_pull",
    "git_merge_upstream",
    "git_rebase",
    "npm_install",
    "pip_install",
    "run_migrations",
    "run_tests",
    "manual_review",
}


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------


class ResolutionProposal:
    """AI-generated resolution for a detected upstream change / conflict."""

    def __init__(
        self,
        summary: str,
        steps: list[str],
        actions: list[str],
        severity: str,          # "info" | "warning" | "critical"
        requires_approval: bool,
        raw_llm_output: str = "",
    ) -> None:
        self.summary = summary
        self.steps = steps
        self.actions = actions
        self.severity = severity
        self.requires_approval = requires_approval
        self.raw_llm_output = raw_llm_output

    def to_dict(self) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "steps": self.steps,
            "actions": self.actions,
            "severity": self.severity,
            "requires_approval": self.requires_approval,
        }


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are an expert DevOps and Git-workflow assistant embedded in an automated developer \
synchronization tool.

A GitHub event was detected on the shared repository. Your tasks are:
1. Summarise the upstream change in 2-3 sentences (plain English, developer audience).
2. Write a numbered list of concrete steps the developer should take to synchronise \
   their local branch safely.
3. Choose the minimal executable actions from the allowed set that the local agent \
   should run automatically after developer approval.

Respond ONLY with a valid JSON object — no markdown fences, no extra text:
{
  "summary":          "2-3 sentence plain-English summary of the upstream change",
  "severity":         "info" | "warning" | "critical",
  "steps": [
    "Step 1: ...",
    "Step 2: ..."
  ],
  "actions": ["git_fetch", "git_pull"],
  "requires_approval": true | false,
  "reasoning":        "Brief reasoning for the chosen actions and severity"
}

Allowed actions (use ONLY these exact tokens):
  git_fetch, git_pull, git_merge_upstream, git_rebase,
  npm_install, pip_install, run_migrations, run_tests, manual_review

Severity guidelines:
- info:     No conflict detected; routine sync is safe.
- warning:  Potential conflict or risky files touched; human review recommended.
- critical: Definite conflict or breaking change; automatic actions must not run \
            without explicit developer approval.

requires_approval must be true when severity is "warning" or "critical".
"""


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def generate_resolution(
    event_type: str,
    context: dict[str, Any],
    diff: str,
    conflict_report: ConflictReport,
) -> ResolutionProposal:
    """
    Generate an AI-powered resolution proposal.

    Parameters
    ----------
    event_type:       GitHub event type ("push", "pull_request", etc.)
    context:          Extracted event context (from the extractor functions).
    diff:             Unified diff of the upstream change.
    conflict_report:  Output of the conflict detector.
    """
    user_prompt = _build_user_prompt(event_type, context, diff, conflict_report)

    raw = ""
    try:
        raw = await get_client().chat(_SYSTEM_PROMPT, user_prompt)
        data = _parse_json(raw)

        actions = _sanitize_actions(data.get("actions", []))
        severity = data.get("severity", "info")
        requires_approval = bool(data.get("requires_approval", severity != "info"))

        # Ensure manual_review is always in the list when there's a conflict
        if conflict_report.has_conflict and "manual_review" not in actions:
            actions.append("manual_review")

        return ResolutionProposal(
            summary=data.get("summary", "Upstream change detected."),
            steps=data.get("steps", []),
            actions=actions,
            severity=severity,
            requires_approval=requires_approval,
            raw_llm_output=raw,
        )

    except Exception as exc:
        logger.exception("LLM resolution generation failed: %s", exc)
        return _fallback_proposal(event_type, conflict_report, raw)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_user_prompt(
    event_type: str,
    context: dict[str, Any],
    diff: str,
    report: ConflictReport,
) -> str:
    conflict_block = (
        f"Conflict detected: YES\n"
        f"  Type:           {report.conflict_type}\n"
        f"  Confidence:     {report.confidence:.0%}\n"
        f"  Affected files: {', '.join(report.affected_files) or 'unknown'}\n"
        f"  Description:    {report.description}"
        if report.has_conflict
        else "Conflict detected: NO"
    )

    diff_section = f"```diff\n{diff}\n```" if diff.strip() else "(diff not available)"

    return f"""\
GitHub event type: {event_type}

Event context:
{json.dumps(context, indent=2)}

Conflict analysis:
{conflict_block}

Upstream diff:
{diff_section}

Generate the JSON resolution proposal.
"""


def _sanitize_actions(raw_actions: list[Any]) -> list[str]:
    """Keep only recognised action tokens to prevent prompt-injection attacks."""
    sanitized = [a for a in raw_actions if isinstance(a, str) and a in VALID_ACTIONS]
    if not sanitized:
        # Minimum safe default — always fetch so the local repo is up-to-date
        sanitized = ["git_fetch"]
    return sanitized


def _fallback_proposal(
    event_type: str,
    report: ConflictReport,
    raw: str,
) -> ResolutionProposal:
    """
    Conservative fallback used when the LLM call fails.
    """
    if report.has_conflict:
        return ResolutionProposal(
            summary="An upstream change was detected that may conflict with your local branch. "
                    "Manual review is required.",
            steps=[
                "Run `git fetch --all` to download upstream changes.",
                "Inspect the diff with `git diff HEAD origin/<branch>`.",
                "Resolve any conflicts manually before merging.",
                "Run tests after resolving conflicts.",
            ],
            actions=["git_fetch", "manual_review"],
            severity="warning",
            requires_approval=True,
            raw_llm_output=raw,
        )

    # Derive minimal safe actions from event type
    actions: list[str] = ["git_fetch", "git_pull"]
    if event_type == "push":
        actions.append("run_tests")

    return ResolutionProposal(
        summary=f"Upstream {event_type} detected. Your local branch may be behind.",
        steps=[
            "Run `git fetch --all`.",
            "Run `git pull` to fast-forward your local branch.",
            "Run your test suite to verify nothing is broken.",
        ],
        actions=actions,
        severity="info",
        requires_approval=False,
        raw_llm_output=raw,
    )


def _parse_json(text: str) -> dict[str, Any]:
    stripped = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    return json.loads(stripped)
