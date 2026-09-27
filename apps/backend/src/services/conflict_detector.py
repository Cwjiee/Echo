"""
Conflict detector.

Analyses whether an upstream change (push/PR diff) is likely to conflict
with a developer's local branch state by asking the watsonx.ai LLM.

The module works in two layers:
  1. Heuristic pre-screening — fast, no LLM call, catches obvious cases.
  2. LLM-based analysis     — deep semantic analysis for non-obvious conflicts.

Both layers return a ConflictReport that is fed back into the AI analyzer.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from src.services.groq_client import get_client

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


class ConflictReport:
    """Structured output of the conflict detection stage."""

    def __init__(
        self,
        has_conflict: bool,
        confidence: float,           # 0.0 – 1.0
        conflict_type: str,          # "none" | "merge" | "dependency" | "schema" | "logic"
        affected_files: list[str],
        description: str,
        raw_llm_output: str = "",
    ) -> None:
        self.has_conflict = has_conflict
        self.confidence = confidence
        self.conflict_type = conflict_type
        self.affected_files = affected_files
        self.description = description
        self.raw_llm_output = raw_llm_output

    def to_dict(self) -> dict[str, Any]:
        return {
            "has_conflict": self.has_conflict,
            "confidence": self.confidence,
            "conflict_type": self.conflict_type,
            "affected_files": self.affected_files,
            "description": self.description,
        }


# ---------------------------------------------------------------------------
# Heuristic pre-screener (no LLM)
# ---------------------------------------------------------------------------

# Files whose modification is almost always a source of conflicts
_HIGH_RISK_PATTERNS = [
    r"package(-lock)?\.json$",
    r"requirements([-_].*)?\.txt$",
    r"pyproject\.toml$",
    r"Pipfile(\.lock)?$",
    r"yarn\.lock$",
    r"pnpm-lock\.yaml$",
    r".*migrations?/.*",
    r"schema\.(prisma|sql|graphql)$",
    r"\.env(\.\w+)?$",
    r"docker-compose.*\.ya?ml$",
]

_HIGH_RISK_RE = [re.compile(p) for p in _HIGH_RISK_PATTERNS]


def _heuristic_screen(changed_files: list[dict[str, Any]]) -> tuple[bool, list[str], str]:
    """
    Returns (flagged, risky_files, reason).

    A change is flagged if any modified file matches a high-risk pattern,
    because those files almost always need attention from every developer.
    """
    risky: list[str] = []
    for f in changed_files:
        name = f.get("filename", "")
        if any(r.search(name) for r in _HIGH_RISK_RE):
            risky.append(name)

    if risky:
        return True, risky, f"High-risk files changed: {', '.join(risky)}"
    return False, [], ""


# ---------------------------------------------------------------------------
# LLM-based conflict analysis
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are an expert software-conflict analyst embedded in a developer synchronization tool.
Your job is to detect whether an upstream code change (provided as a unified diff) is \
likely to cause merge conflicts or integration issues for a developer's local branch.

Respond ONLY with a valid JSON object — no markdown fences, no extra text — matching this schema:
{
  "has_conflict": true | false,
  "confidence": 0.0-1.0,
  "conflict_type": "none" | "merge" | "dependency" | "schema" | "logic",
  "affected_files": ["list", "of", "file", "paths"],
  "description": "A concise explanation (2-4 sentences) of what the conflict is and why it occurs.",
  "resolution_hint": "One concrete sentence on the most likely way to resolve it."
}

Definitions:
- merge:      direct text-level conflict in the same lines/functions
- dependency: package.json / requirements.txt / lock-file divergence
- schema:     database migration or GraphQL schema incompatibility
- logic:      behavioral / API contract change that is not a text conflict but will break callers
- none:       no meaningful conflict detected
"""


async def analyse_conflict(
    diff: str,
    local_branch: str = "unknown",
    upstream_branch: str = "unknown",
    changed_files: list[dict[str, Any]] | None = None,
) -> ConflictReport:
    """
    Run conflict detection against an upstream diff.

    Parameters
    ----------
    diff:             Unified diff of the upstream change.
    local_branch:     Developer's local branch name (context for the LLM).
    upstream_branch:  The branch that was pushed to / merged.
    changed_files:    Optional list of file-change objects from the GitHub API.
    """
    changed_files = changed_files or []

    # --- Layer 1: heuristic ---
    heuristic_flagged, risky_files, heuristic_reason = _heuristic_screen(changed_files)

    if not diff.strip():
        # Nothing to analyse
        return ConflictReport(
            has_conflict=heuristic_flagged,
            confidence=0.6 if heuristic_flagged else 0.1,
            conflict_type="dependency" if heuristic_flagged else "none",
            affected_files=risky_files,
            description=heuristic_reason or "No diff content available for analysis.",
        )

    # --- Layer 2: LLM ---
    user_prompt = f"""\
Local branch:    {local_branch}
Upstream branch: {upstream_branch}

Upstream unified diff:
```
{diff}
```

{f"Pre-screener flagged these high-risk files: {risky_files}" if risky_files else ""}

Analyse the diff and return the JSON conflict report.
"""
    raw = ""
    try:
        raw = await get_client().chat(_SYSTEM_PROMPT, user_prompt)
        data = _parse_json(raw)
        return ConflictReport(
            has_conflict=bool(data.get("has_conflict", heuristic_flagged)),
            confidence=float(data.get("confidence", 0.5)),
            conflict_type=data.get("conflict_type", "none"),
            affected_files=data.get("affected_files", risky_files),
            description=data.get("description", ""),
            raw_llm_output=raw,
        )
    except Exception as exc:
        logger.exception("LLM conflict analysis failed: %s", exc)
        # Fall back gracefully to heuristic result
        return ConflictReport(
            has_conflict=heuristic_flagged,
            confidence=0.4,
            conflict_type="none",
            affected_files=risky_files,
            description=heuristic_reason or "Conflict analysis unavailable (LLM error).",
            raw_llm_output=raw,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_json(text: str) -> dict[str, Any]:
    """Extract a JSON object from LLM output (strips accidental markdown fences)."""
    # Strip ```json ... ``` fences if present
    stripped = re.sub(r"```(?:json)?\s*", "", text).strip().rstrip("`").strip()
    return json.loads(stripped)
