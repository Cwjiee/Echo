# Local Execution Engine — Contract (Phase 5)

Protocol version 1. Owner: Ted. Implemented by `@echo/local-executor`.

This package runs Git and package-manager commands on a developer's machine on
behalf of the Echo backend. It is the only component that mutates a local
repository, so its interface is fixed here and changed only by agreement.

The machine-readable version of everything below is
[`src/types.ts`](./src/types.ts). Where this document and that file disagree,
the file wins.

## Flow

Analysis runs on the push, before anyone approves. The Cloud AI Agent works
from the GitHub diff and never waits on a local round trip.

1. Backend receives the GitHub push webhook.
2. Cloud AI Agent fetches the diff from GitHub, detects the likely conflict, and
   emits a resolution with `steps` and `actions`.
3. Backend broadcasts the analysis to the Mac Agent over the WebSocket.
4. Mac Agent calls `inspect()` locally on arrival and holds the resulting
   `head_sha` against the proposal's id.
5. ChatOps posts the proposal. The developer approves.
6. Backend forwards the approval to the Mac Agent.
7. Mac Agent calls `apply()`, filling `base_sha` from the `head_sha` it recorded
   at step 4.
8. Engine executes, emits an `ActionProgressEvent` per completed action, and
   returns a single `ApplyResult`, which the Mac Agent sends back as the
   approval response.

`inspect()` stays on the path but moves inside the Mac Agent. It is a local
function call, not a WebSocket round trip, so the wire protocol is one trip.

**`base_sha` is a local SHA, never an upstream one.** The engine compares it
against local `HEAD`. The head of the branch Alice just pushed is by definition
not Bob's `HEAD`, so a resolution stamped with the GitHub SHA is refused with
`STALE_STATE` every single time. Step 4 exists to prevent exactly that.

**The cost of moving analysis earlier.** The Cloud AI Agent no longer sees the
local tree before it writes the patch, so the patch is aimed at the GitHub diff
rather than at this developer's clone. `git apply --3way --check` still refuses
a patch that does not fit, and nothing is mutated when it does, so the failure
mode is a rejection rather than a corrupted tree. The rejection rate is higher
than it was under the two-trip flow. That is the tradeoff this flow buys.

## Entry points

```ts
inspect(request: InspectRequest): Promise<InspectReport>
apply(request: ApplyRequest): Promise<ApplyResult>
```

The Mac Agent imports these directly. The MCP server in `src/mcp-server.ts`
wraps the same leaf functions for local AI tooling; it is not on the sync path.

## Actions

Executed in the order given in `ApplyRequest.actions`.

| Action | Mutates | Notes |
| --- | --- | --- |
| `git_status` | no | `--porcelain` |
| `git_fetch` | no | |
| `git_diff` | no | |
| `git_pull` | yes | `--no-rebase`. Merge commit on conflict-free divergence |
| `git_rebase` | yes | Replays local commits onto upstream. Linear history |
| `apply_patch` | yes | Requires `patch`. Commits on success. |
| `install_deps` | yes | Detects npm, pnpm, or yarn from the lockfile |
| `run_tests` | no | Detects the runner; skips with `success: true` when none exists |

Database migrations are deliberately out of scope. A Git snapshot cannot undo
them, so they have no safe rollback path and version 1 will not run them.

The engine never pushes, and never creates or deletes a branch.

`git_pull` and `git_rebase` reach the same synced state and differ only in
history shape. A conflicted rebase leaves no `MERGE_HEAD`, sets `REBASE_HEAD`
and detaches `HEAD`, so `git merge --abort` does not undo it. `rollback()`
checks `MERGE_HEAD`, `rebase-merge` and `rebase-apply` and runs the matching
abort before resetting. A verb outside the table is refused with
`UNKNOWN_ACTION` before the snapshot is taken.

**An action that throws is not a crash.** The engine rolls back, restores the
stash, and returns `status: 'failed'` with `error: 'ENGINE_ERROR'` and
`error_detail`. A stash is never left behind without an `ApplyResult` naming it.

## Patch format

`ApplyRequest.patch` is a unified diff in `git diff` format, with `a/` and `b/`
prefixes, computed against `base_sha`.

The engine runs `git apply --3way --check` first. A patch that fails the check
is rejected with `PATCH_REJECTED` before anything is mutated. A patch that
passes is applied with `git apply --3way` and committed as
`echo: apply AI resolution <action_id>`, so the developer can review it with
`git show` and it stays separate from their own work.

## Safety rules

These hold for every `apply` call.

**Staleness.** `ApplyRequest.base_sha` must equal current `HEAD`. If the
developer committed or pulled between the notification and their approval, the
engine refuses with `STALE_STATE` and the Mac Agent must re-inspect.

**Idempotency.** `action_id` is the idempotency key. A repeated `action_id`
returns the cached `ApplyResult` with `replayed: true` instead of executing
again. WebSocket reconnects redeliver messages; applying a patch twice is not
survivable.

The cache is in memory and dies with the process, so it protects against a
socket redelivering a message to a running Mac Agent and not against a redeliver
that arrives after the agent restarts. Closing that gap means persisting
`action_id` to disk, which version 1 does not do. A rejected result is never
cached, so retrying an `action_id` after fixing a `STALE_STATE` re-executes
rather than replaying the refusal forever.

**Concurrency.** One operation per repository at a time. The lock is taken
synchronously on entry, before the first `await`. An engine that resolves the
repository path first and locks afterwards lets two concurrent requests both
pass the check. A second request is rejected with `BUSY` rather than queued — a queued apply would execute against
state inspected before the apply ahead of it finished.

**Dirty trees are absorbed, not refused.** The execution sequence is:

1. Record `HEAD` as the restore point.
2. `git stash push --include-untracked` if the tree is dirty.
3. Run the requested actions in order, stopping at the first failure.
4. On failure: `git merge --abort` if a merge is in progress, then
   `git reset --hard <restore point>`, then `git stash pop`.
5. On success: `git stash pop` last, after tests have run.

Tests run before the stash is restored, so a red test means the sync broke the
build rather than the developer's work in progress did.

**A stash is never dropped automatically.** If `git stash pop` fails, the entry
stays and `ApplyResult.stash_retained` says so. Losing a developer's
uncommitted work once is enough for them to never trust the tool again.

**Test failures do not roll back.** A clean pull whose tests fail is real
information, not a mistake to undo. `ApplyResult.status` is `failed` and the
repository is left synced.

## Limits

Per-action timeouts are in `ACTION_TIMEOUT_MS`. A timeout kills the process
tree, fails the action, and therefore triggers rollback. `install_deps` is
allowed 300 s because a cold install on a fresh clone genuinely takes that long.

`stdout` and `stderr` are truncated to 8 KB from the head and 8 KB from the
tail, with a marker in between, and `ExecutionResult.truncated` is set.

`InspectReport.diff.text` is capped at 100 KB. `diff_stat` is never truncated —
the AI needs file-level breadth more than it needs every hunk.

## Configuration

Read from `~/.echo/config.json`, written by the Mac Agent settings UI:

```json
{
  "scanRoots": ["~/code", "~/Documents/projects"],
  "maxDepth": 3,
  "repoOverrides": { "acme/repo-a": "/Users/you/work/repo-a" }
}
```

To resolve a repository slug the engine checks `repoOverrides`, then scans each
root to `maxDepth` for directories containing `.git`, and matches
`git remote get-url origin` against the slug after normalising SSH and HTTPS
forms and stripping `.git`. No match is `REPO_NOT_FOUND`. `repoOverrides` is
the escape hatch for a machine with two clones of the same repository.

Environment variables override the file during development:
`ECHO_REPO_PATH`, `ECHO_SCAN_ROOTS`, `ECHO_MAX_DEPTH`.

## Rehearsing locally

No backend, Discord, or Mac Agent needed. `scripts/seed-fixture.mjs` builds a
bare origin with two clones and a seeded conflict. `scripts/echo.mjs` drives
`inspect()` and `apply()` against any repository and stands in for the Mac
Agent, reading local `HEAD` and filling `base_sha` itself.

```sh
node scripts/seed-fixture.mjs --scenario dirty-and-conflicting --out /tmp/echo-demo
node scripts/echo.mjs inspect --repo /tmp/echo-demo/alice
node scripts/echo.mjs apply --repo /tmp/echo-demo/alice \
  --actions git_fetch,git_rebase,run_tests --branch main
```

Scenarios are `up-to-date`, `clean-behind`, `conflicting` and
`dirty-and-conflicting`. `apply` prints the repository before and after, one
line per action, and the branch, HEAD, working tree and stash list on both
sides, which is how a rollback is confirmed by eye. Exit status is 0 only when
`ApplyResult.status` is `success`.

`--patch <file>` supplies the unified diff for `apply_patch`, `--base <sha>`
forces a deliberately stale value to see `STALE_STATE`, and `--id` pins the
`action_id`. Replay cannot be seen from the CLI, because each invocation is a
new process and the cache does not outlive one.

## What each phase owes

**Phase 1, Backend (Wei Jie)** — broadcast the analysis at step 3 and forward
the approval at step 6, carrying `action_id` unchanged in both directions. Do
not populate `base_sha`; the Mac Agent owns it. Handle `BUSY` and `STALE_STATE`
by asking the Mac Agent to re-inspect.

**Phase 2, Cloud AI Agent (naviin)** — emit patches in the format above. Choose
actions from the table above only. Do not emit `base_sha`; you cannot know it at
step 2.

**Phase 3, ChatOps (syuen)** — `ActionProgressEvent` arrives once per completed
action and can update the thread live. `ApplyResult.stash_retained`,
`rolled_back` and `error_detail` all need to be visible to the developer.

**Phase 4, Mac Agent (Jan)** — write `~/.echo/config.json` from the settings UI.
Call `inspect()` when the analysis arrives, keep `head_sha` against the
`action_id`, and pass it as `base_sha` when the approval comes back. Snapshot
and rollback ordering lives in the engine, so never sequence actions in
`executor-bridge.ts`.
