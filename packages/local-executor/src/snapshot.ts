/**
 * The restore point an apply() runs against: HEAD plus, when the tree was
 * dirty, a stash of the developer's work in progress.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import { captureGit } from './exec.js';

export interface Snapshot {
  baseSha: string;
  stashRef: string | null;
}

export interface StashRetained {
  ref: string;
  reason: string;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function takeSnapshot(workdir: string, actionId: string): Promise<Snapshot> {
  const head = await captureGit(workdir, ['rev-parse', 'HEAD']);
  const baseSha = head.stdout.trim();

  const status = await captureGit(workdir, ['status', '--porcelain']);
  if (status.stdout.trim() === '') return { baseSha, stashRef: null };

  const push = await captureGit(workdir, [
    'stash',
    'push',
    '--include-untracked',
    '--message',
    `echo-${actionId}`,
  ]);
  return { baseSha, stashRef: push.exitCode === 0 ? 'stash@{0}' : null };
}

/**
 * Operations `git reset --hard` cannot undo on its own, each paired with the
 * path inside .git that proves one is in progress. A conflicted rebase leaves
 * no MERGE_HEAD and a detached HEAD, so a rollback that only knows about merges
 * resets the tree and leaves the developer stranded mid-rebase.
 */
const INTERRUPTED_OPERATIONS: ReadonlyArray<{ gitPath: string; abort: string[] }> = [
  { gitPath: 'MERGE_HEAD', abort: ['merge', '--abort'] },
  { gitPath: 'rebase-merge', abort: ['rebase', '--abort'] },
  { gitPath: 'rebase-apply', abort: ['rebase', '--abort'] },
];

export async function rollback(workdir: string, snapshot: Snapshot): Promise<void> {
  for (const { gitPath, abort } of INTERRUPTED_OPERATIONS) {
    const resolved = await captureGit(workdir, ['rev-parse', '--git-path', gitPath]);
    if (resolved.exitCode !== 0) continue;
    // --git-path answers relative to the repository, so resolve it against workdir.
    if (!(await exists(path.resolve(workdir, resolved.stdout.trim())))) continue;
    await captureGit(workdir, abort);
    break;
  }
  await captureGit(workdir, ['reset', '--hard', snapshot.baseSha]);
}

/**
 * Returns the retention record when the pop failed, null otherwise. A failed
 * pop leaves the entry in the stash list: `git stash drop` appears nowhere in
 * this package, because losing a developer's uncommitted work once is enough
 * for them to never trust the tool again.
 */
export async function restoreStash(
  workdir: string,
  snapshot: Snapshot,
): Promise<StashRetained | null> {
  if (!snapshot.stashRef) return null;

  const pop = await captureGit(workdir, ['stash', 'pop']);
  if (pop.exitCode === 0) return null;

  const reason = (pop.stderr.trim() || pop.stdout.trim()) || `git stash pop exited ${pop.exitCode}`;
  return { ref: snapshot.stashRef, reason };
}
