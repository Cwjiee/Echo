/**
 * The action vocabulary as data. Adding an action is a row here, not a branch
 * in apply(), and rollbackOnFailure is the only place the rule "test failures
 * do not roll back" is written down.
 */

import { captureGit } from './exec.js';
import { applyPatch, gitDiff, gitFetch, gitPull, gitRebase, gitStatus } from './tools/git.js';
import { installDeps } from './tools/npm.js';
import { runTests } from './tools/tests.js';
import type { ActionName, ApplyRequest, ExecutionResult } from './types.js';

export interface ActionContext {
  workdir: string;
  request: ApplyRequest;
  /** apply_patch reports the commit it made so apply() can surface patch_commit_sha. */
  onPatchCommit(sha: string): void;
}

export interface ActionSpec {
  run(ctx: ActionContext): Promise<ExecutionResult>;
  rollbackOnFailure: boolean;
}

export const ACTIONS: Record<ActionName, ActionSpec> = {
  git_status: {
    run: (ctx) => gitStatus(ctx.workdir),
    rollbackOnFailure: true,
  },
  git_fetch: {
    run: (ctx) => gitFetch(ctx.workdir, ctx.request.context?.remote),
    rollbackOnFailure: true,
  },
  git_diff: {
    run: (ctx) => gitDiff(ctx.workdir),
    rollbackOnFailure: true,
  },
  git_pull: {
    run: (ctx) => gitPull(ctx.workdir, ctx.request.context?.remote, ctx.request.context?.branch),
    rollbackOnFailure: true,
  },
  git_rebase: {
    run: (ctx) =>
      gitRebase(ctx.workdir, ctx.request.context?.remote, ctx.request.context?.branch),
    rollbackOnFailure: true,
  },
  apply_patch: {
    async run(ctx) {
      const result = await applyPatch(ctx.workdir, ctx.request.patch ?? '', ctx.request.action_id);
      if (result.success) {
        const head = await captureGit(ctx.workdir, ['rev-parse', 'HEAD']);
        if (head.exitCode === 0) ctx.onPatchCommit(head.stdout.trim());
      }
      return result;
    },
    rollbackOnFailure: true,
  },
  install_deps: {
    run: (ctx) => installDeps(ctx.workdir),
    rollbackOnFailure: true,
  },
  run_tests: {
    run: (ctx) => runTests(ctx.workdir),
    rollbackOnFailure: false,
  },
};
