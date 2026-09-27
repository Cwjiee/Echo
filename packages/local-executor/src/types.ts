/**
 * @echo/local-executor — protocol types.
 *
 * This file is the contract between the Local Execution Engine (Phase 5) and
 * the Cloud AI Agent (Phase 2), the Backend (Phase 1), and the Mac Agent
 * (Phase 4). See CONTRACT.md in this package for the prose version.
 *
 * Frozen at PROTOCOL_VERSION 1. Additive changes only; anything else needs a
 * version bump and a message to the other phases.
 */

export const PROTOCOL_VERSION = 1;

// ── Actions ───────────────────────────────────────────────────────────────

export type ActionName =
  | 'git_status'
  | 'git_fetch'
  | 'git_diff'
  | 'git_pull'
  | 'git_rebase'
  | 'apply_patch'
  | 'install_deps'
  | 'run_tests';

/** Wall-clock budget per action, in milliseconds. Exceeding it kills the process tree and fails the action. */
export const ACTION_TIMEOUT_MS: Record<ActionName, number> = {
  git_status: 10_000,
  git_diff: 10_000,
  git_fetch: 60_000,
  git_pull: 60_000,
  git_rebase: 60_000,
  apply_patch: 30_000,
  install_deps: 300_000,
  run_tests: 120_000,
};

/** Each of stdout and stderr is truncated to this many bytes from the head and the same from the tail. */
export const OUTPUT_HEAD_TAIL_BYTES = 8_192;

/** Marker inserted where output was elided. */
export const TRUNCATION_MARKER = '\n…[echo: output truncated]…\n';

export interface ExecutionResult {
  action: ActionName;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True when stdout or stderr was elided to fit OUTPUT_HEAD_TAIL_BYTES. */
  truncated: boolean;
  /** True when the action was killed for exceeding ACTION_TIMEOUT_MS. */
  timedOut: boolean;
}

// ── Inspect: first round trip ─────────────────────────────────────────────

export interface InspectRequest {
  protocol_version: number;
  request_id: string;
  /** Repository slug as GitHub reports it, e.g. "acme/repo-a". */
  repository: string;
  /** Branch the backend believes changed upstream. Defaults to the repo's current branch. */
  branch?: string;
  /** Overrides repository path resolution, mirroring ApplyRequest.context.workdir. Must be absolute. */
  workdir?: string;
}

export interface InspectReport {
  protocol_version: number;
  request_id: string;
  repository: string;
  /** Absolute path the engine resolved for this repository on this machine. */
  path: string;
  branch: string;
  /**
   * Local HEAD at the moment of inspection. The matching apply request must
   * echo this value as base_sha, or the engine refuses with STALE_STATE.
   */
  head_sha: string;
  upstream_sha: string;
  merge_base: string;
  /** Commits on HEAD that are not upstream. */
  ahead: number;
  /** Commits upstream that are not on HEAD. */
  behind: number;
  /** Paths with uncommitted changes, including untracked files. */
  dirty: string[];
  /** Output of `git diff --stat merge_base...upstream_sha`. Never truncated. */
  diff_stat: string;
  diff: {
    /** Output of `git diff merge_base...upstream_sha`. Upstream changes only. */
    text: string;
    truncated: boolean;
    /** Byte length before truncation. */
    original_bytes: number;
  };
}

/** Diffs larger than this are truncated in InspectReport.diff.text. diff_stat still ships whole. */
export const MAX_DIFF_BYTES = 100_000;

// ── Apply: second round trip ──────────────────────────────────────────────

export interface ApplyRequest {
  protocol_version: number;
  /** Idempotency key. Replaying an action_id returns the cached result instead of re-executing. */
  action_id: string;
  repository: string;
  /**
   * Local HEAD at the moment the resolution was shown to the developer, taken
   * from InspectReport.head_sha. Never an upstream or GitHub SHA: the engine
   * compares it against local HEAD and refuses with STALE_STATE on a mismatch,
   * so an upstream SHA rejects every request by construction.
   */
  base_sha: string;
  /** Executed in array order. The engine stops at the first failure and rolls back. */
  actions: ActionName[];
  /**
   * Required when actions includes 'apply_patch'.
   * Unified diff in `git diff` format with a/ and b/ prefixes, relative to base_sha.
   */
  patch?: string;
  context?: {
    branch?: string;
    remote?: string;
    /** Overrides repository path resolution. Must be an absolute path. */
    workdir?: string;
  };
}

export type ApplyStatus = 'success' | 'failed' | 'rejected';

export type ApplyErrorCode =
  /** HEAD no longer matches base_sha. Re-inspect and re-propose. */
  | 'STALE_STATE'
  /** actions contains a verb outside ActionName. Nothing was mutated. */
  | 'UNKNOWN_ACTION'
  /**
   * An action threw rather than failing. The repository was rolled back and any
   * stash restored. Accompanied by status 'failed', not 'rejected'.
   */
  | 'ENGINE_ERROR'
  /** Another inspect or apply is in flight for this repository. Retry after re-inspecting. */
  | 'BUSY'
  /** No local clone found for this repository slug. */
  | 'REPO_NOT_FOUND'
  /** `git apply --3way --check` rejected the patch. Nothing was mutated. */
  | 'PATCH_REJECTED'
  /** actions includes 'apply_patch' but no patch was supplied. */
  | 'PATCH_MISSING'
  /** protocol_version is not supported by this engine. */
  | 'PROTOCOL_MISMATCH';

export interface ApplyResult {
  protocol_version: number;
  action_id: string;
  repository: string;
  status: ApplyStatus;
  /**
   * Present when status is 'rejected', where no actions ran, and when status is
   * 'failed' with error 'ENGINE_ERROR'.
   */
  error?: ApplyErrorCode;
  /** Human-readable detail for ENGINE_ERROR. Never set for a normal action failure. */
  error_detail?: string;
  /** One entry per action that ran, in execution order. */
  results: ExecutionResult[];
  /** True when a mutating action failed and the repository was restored to base_sha. */
  rolled_back: boolean;
  /** SHA of the commit created by apply_patch, when one was created. */
  patch_commit_sha?: string;
  /**
   * Set when a stash was taken and `git stash pop` did not succeed. The stash
   * entry is left in place — the engine never drops a stash automatically.
   */
  stash_retained?: {
    ref: string;
    reason: string;
  };
  /** True when this response was served from the idempotency cache. */
  replayed: boolean;
}

/** Emitted once per completed action so the chat thread can update while a sync runs. */
export interface ActionProgressEvent {
  action_id: string;
  repository: string;
  index: number;
  total: number;
  result: ExecutionResult;
}

// ── Local configuration ───────────────────────────────────────────────────

/**
 * Read from ~/.echo/config.json. Written by the Mac Agent settings UI.
 * Every field is optional; the engine falls back to the documented defaults.
 */
export interface EchoConfig {
  /** Directories searched for local clones. Leading ~ is expanded. */
  scanRoots?: string[];
  /** Directory levels descended below each scan root. */
  maxDepth?: number;
  /** Explicit slug-to-path mapping. Wins over the scan. */
  repoOverrides?: Record<string, string>;
}

export const DEFAULT_CONFIG: Required<EchoConfig> = {
  scanRoots: ['~/code', '~/Documents/projects', '~/dev'],
  maxDepth: 3,
  repoOverrides: {},
};
