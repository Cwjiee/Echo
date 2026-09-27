"""
Application configuration.

All settings are loaded from environment variables (with sensible defaults for
local development).  The Settings singleton is available via `get_settings()`.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root — works regardless of where the process is launched from
_REPO_ROOT = Path(__file__).resolve().parents[3]  # src/config.py → src → backend → apps → echo/


class Settings(BaseSettings):
    """Central configuration for the Echo backend."""

    model_config = SettingsConfigDict(
        # Check repo root first, then local apps/backend/.env as fallback
        env_file=[str(_REPO_ROOT / ".env"), ".env"],
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ------------------------------------------------------------------
    # Server
    # ------------------------------------------------------------------
    app_env: str = Field("development", description="development | staging | production")
    log_level: str = Field("INFO", description="Python logging level")

    # ------------------------------------------------------------------
    # Database (Postgres via asyncpg)
    # ------------------------------------------------------------------
    database_url: str = Field(
        "postgresql+asyncpg://echo:echo@localhost:5432/echo",
        description="SQLAlchemy async DSN for Postgres",
    )

    # ------------------------------------------------------------------
    # Redis
    # ------------------------------------------------------------------
    redis_url: str = Field(
        "redis://localhost:6379/0",
        description="Redis connection URL",
    )

    # ------------------------------------------------------------------
    # GitHub Webhook
    # ------------------------------------------------------------------
    github_webhook_secret: str = Field(
        "changeme",
        description="HMAC secret shared with GitHub webhook settings",
    )
    github_token: str | None = Field(
        None,
        description="GitHub PAT / App token for API calls (avoids rate limits)",
    )

    # ------------------------------------------------------------------
    # Agent authentication
    # ------------------------------------------------------------------
    # Comma-separated list of valid auth tokens for Mac agent connections.
    # Example:  AGENT_AUTH_TOKENS=token1,token2,token3
    agent_auth_tokens: str = Field(
        "",
        description="Comma-separated valid tokens for Mac agent Socket.IO connections",
    )

    @field_validator("agent_auth_tokens", mode="before")
    @classmethod
    def _strip_token_whitespace(cls, v: str) -> str:
        return v.strip()

    @property
    def valid_agent_tokens(self) -> set[str]:
        """Return the set of accepted agent auth tokens.

        An empty string disables token enforcement (dev mode only).
        """
        if not self.agent_auth_tokens:
            return set()
        return {t.strip() for t in self.agent_auth_tokens.split(",") if t.strip()}

    # ------------------------------------------------------------------
    # AI / Groq
    # ------------------------------------------------------------------
    groq_api_key: str = Field(
        "",
        description="Groq API key — required for AI analysis in production",
    )
    groq_model: str = Field(
        "llama-3.3-70b-versatile",
        description="Groq model to use for LLM inference",
    )

    # ------------------------------------------------------------------
    # Feature flags
    # ------------------------------------------------------------------
    skip_signature_check: bool = Field(
        False,
        description="Disable HMAC signature verification (NEVER enable in production)",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the singleton Settings instance (cached after first call)."""
    return Settings()
