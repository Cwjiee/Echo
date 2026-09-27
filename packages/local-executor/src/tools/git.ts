/**
 * Git leaves. Each returns an ExecutionResult and routes through runCommand, so
 * timeouts and output truncation are identical whether the caller is an ACTIONS
 * row or the MCP server.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../exec.js';
import type { ActionName, ExecutionResult } from '../types.js';

function git(action: ActionName, workdir: string, args: string[]): Promise<ExecutionResult> {
  return runCommand({ action, command: 'git', args, cwd: workdir });
}

export function gitStatus(workdir: string): Promise<ExecutionResult> {
  return git('git_status', workdir, ['status', '--porcelain']);
}

export function gitFetch(workdir: string, remote = 'origin'): Promise<ExecutionResult> {
  return git('git_fetch', workdir, ['fetch', remote]);
}

export function gitDiff(workdir: string, ...revisions: string[]): Promise<ExecutionResult> {
  return git('git_diff', workdir, ['diff', ...revisions]);
}

export function gitPull(
  workdir: string,
  remote?: string,
  branch?: string,
): Promise<ExecutionResult> {
  // Without --no-rebase, git 2.50 refuses divergent branches outright ("Need to
  // specify how to reconcile divergent branches") instead of attempting the
  // merge whose conflict the engine is built to roll back.
  const target = remote ? (branch ? [remote, branch] : [remote]) : [];
  return git('git_pull', workdir, ['pull', '--no-rebase', ...target]);
}

/**
 * Rebases onto the upstream branch. A conflict exits non-zero and leaves the
 * repository detached mid-rebase; rollback() aborts it before resetting.
 */
export function gitRebase(
  workdir: string,
  remote = 'origin',
  branch?: string,
): Promise<ExecutionResult> {
  const upstream = branch ? `${remote}/${branch}` : remote;
  return git('git_rebase', workdir, ['rebase', upstream]);
}

async function withPatchFile<T>(patch: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'echo-patch-'));
  try {
    const file = path.join(dir, 'resolution.patch');
    // A unified diff is line-oriented and git rejects one whose last line is
    // unterminated, which is what a transport that trims trailing whitespace
    // hands us.
    await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`);
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Dry run used as the last apply() guard. Nothing is mutated either way. */
export function checkPatch(workdir: string, patch: string): Promise<ExecutionResult> {
  return withPatchFile(patch, (file) =>
    git('apply_patch', workdir, ['apply', '--3way', '--check', file]),
  );
}

export function applyPatch(
  workdir: string,
  patch: string,
  actionId: string,
): Promise<ExecutionResult> {
  return withPatchFile(patch, async (file) => {
    const applied = await git('apply_patch', workdir, ['apply', '--3way', file]);
    if (!applied.success) return applied;

    const staged = await git('apply_patch', workdir, ['add', '-A']);
    if (!staged.success) return staged;

    const committed = await git('apply_patch', workdir, [
      'commit',
      '-m',
      `echo: apply AI resolution ${actionId}`,
    ]);
    return {
      ...committed,
      stdout: [applied.stdout, committed.stdout].filter(Boolean).join('\n'),
      stderr: [applied.stderr, committed.stderr].filter(Boolean).join('\n'),
      durationMs: applied.durationMs + staged.durationMs + committed.durationMs,
      truncated: applied.truncated || staged.truncated || committed.truncated,
    };
  });
}
