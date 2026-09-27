/**
 * Executable spec for inspect() and apply(). Every assertion is a literal
 * value from CONTRACT.md. Leaf-tool behavior lives in tools.test.ts.
 *
 * inspect() resolves its repository via ECHO_REPO_PATH (CONTRACT.md,
 * Configuration). apply() resolves via ApplyRequest.context.workdir
 * (types.ts), which is the documented override for path resolution.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { execa } from 'execa';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, type Fixture } from './fixtures.js';
import { inspect, apply } from '../src/index.js';
import { ACTIONS } from '../src/actions.js';
import { takeSnapshot, rollback } from '../src/snapshot.js';
import type { InspectRequest, ApplyRequest } from '../src/types.js';

async function headSha(dir: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function branchName(dir: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

async function porcelain(dir: string): Promise<string> {
  const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: dir });
  return stdout.trim();
}

async function stashList(dir: string): Promise<string> {
  const { stdout } = await execa('git', ['stash', 'list'], { cwd: dir });
  return stdout.trim();
}

async function revListCount(dir: string, range: string): Promise<number> {
  const { stdout } = await execa('git', ['rev-list', '--count', range], { cwd: dir });
  return Number(stdout.trim());
}

/** Edits bob's clean working copy to produce a real, git-generated unified diff, then reverts it. */
async function makePatch(fixture: Fixture, edited: string): Promise<string> {
  const target = path.join(fixture.bob, 'src/app.js');
  await writeFile(target, edited);
  const { stdout } = await execa('git', ['diff'], { cwd: fixture.bob, stripFinalNewline: false });
  await execa('git', ['checkout', '--', 'src/app.js'], { cwd: fixture.bob });
  return stdout;
}

function inspectRequest(fixture: Fixture, overrides: Partial<InspectRequest> = {}): InspectRequest {
  return {
    protocol_version: 1,
    request_id: 'req-1',
    repository: fixture.slug,
    ...overrides,
  };
}

function applyRequest(fixture: Fixture, overrides: Partial<ApplyRequest> = {}): ApplyRequest {
  return {
    protocol_version: 1,
    action_id: 'action-1',
    repository: fixture.slug,
    base_sha: '',
    actions: [],
    context: { workdir: fixture.alice },
    ...overrides,
  };
}

let fixture: Fixture | undefined;

afterEach(async () => {
  delete process.env.ECHO_REPO_PATH;
  await fixture?.cleanup();
  fixture = undefined;
});

describe('inspect', () => {
  test('reports behind, ahead, dirty, and head_sha for clean-behind', async () => {
    fixture = await createFixture('clean-behind');
    process.env.ECHO_REPO_PATH = fixture.alice;
    const report = await inspect(inspectRequest(fixture));
    expect(report.behind).toBe(1);
    expect(report.ahead).toBe(0);
    expect(report.dirty).toEqual([]);
    expect(report.head_sha).toBe(await headSha(fixture.alice));
  });

  test('diff_stat mentions the upstream-changed file', async () => {
    fixture = await createFixture('clean-behind');
    process.env.ECHO_REPO_PATH = fixture.alice;
    const report = await inspect(inspectRequest(fixture));
    expect(report.diff_stat).toContain('src/util.js');
  });
});

describe('apply', () => {
  test('rejects a stale base_sha with an empty results array', async () => {
    fixture = await createFixture('up-to-date');
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'stale-1',
        base_sha: '0'.repeat(40),
        actions: ['git_fetch'],
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('STALE_STATE');
    expect(result.results).toEqual([]);
  });

  test('replaying an action_id returns the cached result instead of re-running', async () => {
    fixture = await createFixture('up-to-date');
    const base_sha = await headSha(fixture.alice);
    const request = applyRequest(fixture, {
      action_id: 'replay-1',
      base_sha,
      actions: ['git_fetch'],
    });
    const first = await apply(request);
    const second = await apply(request);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.results).toEqual(first.results);
  });

  test('rolls back git_pull on a dirty conflicting tree and preserves the dirty file', async () => {
    fixture = await createFixture('dirty-and-conflicting');
    const base_sha = await headSha(fixture.alice);
    const dirtyBefore = await readFile(path.join(fixture.alice, 'src/dirty.txt'), 'utf8');
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'rollback-1',
        base_sha,
        actions: ['git_fetch', 'git_pull'],
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.rolled_back).toBe(true);
    expect(await headSha(fixture.alice)).toBe(base_sha);
    expect(await readFile(path.join(fixture.alice, 'src/dirty.txt'), 'utf8')).toBe(dirtyBefore);
  });

  test('pulls cleanly on clean-behind and leaves nothing left to fetch', async () => {
    fixture = await createFixture('clean-behind');
    const base_sha = await headSha(fixture.alice);
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'pull-1',
        base_sha,
        actions: ['git_fetch', 'git_pull'],
      }),
    );
    expect(result.status).toBe('success');
    expect(await revListCount(fixture.alice, 'HEAD..origin/main')).toBe(0);
  });

  test('rejects apply_patch with no patch supplied', async () => {
    fixture = await createFixture('up-to-date');
    const base_sha = await headSha(fixture.alice);
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'patch-missing',
        base_sha,
        actions: ['apply_patch'],
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('PATCH_MISSING');
  });

  test('rejects a malformed patch and leaves HEAD unchanged', async () => {
    fixture = await createFixture('up-to-date');
    const base_sha = await headSha(fixture.alice);
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'patch-bad',
        base_sha,
        actions: ['apply_patch'],
        patch: 'this is not a unified diff\n@@ garbage @@\n',
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('PATCH_REJECTED');
    expect(await headSha(fixture.alice)).toBe(base_sha);
  });

  test('applies a valid patch, commits it, and names the action_id in the message', async () => {
    fixture = await createFixture('up-to-date');
    const base_sha = await headSha(fixture.alice);
    const current = await readFile(path.join(fixture.alice, 'src/app.js'), 'utf8');
    const patch = await makePatch(fixture, current.replace('return 4;', 'return 40;'));
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'patch-good',
        base_sha,
        actions: ['apply_patch'],
        patch,
      }),
    );
    expect(result.status).toBe('success');
    expect(result.patch_commit_sha).toBe(await headSha(fixture.alice));
    const { stdout: message } = await execa('git', ['log', '-1', '--format=%B', result.patch_commit_sha as string], {
      cwd: fixture.alice,
    });
    expect(message).toContain('patch-good');
    expect(await readFile(path.join(fixture.alice, 'src/app.js'), 'utf8')).toContain('return 40;');
  });

  test('rejects a concurrent apply on the same repository as BUSY', async () => {
    fixture = await createFixture('clean-behind');
    const base_sha = await headSha(fixture.alice);
    const first = apply(
      applyRequest(fixture, {
        action_id: 'busy-1',
        base_sha,
        actions: ['git_fetch', 'git_pull'],
      }),
    );
    const second = await apply(
      applyRequest(fixture, {
        action_id: 'busy-2',
        base_sha,
        actions: ['git_fetch'],
      }),
    );
    expect(second.status).toBe('rejected');
    expect(second.error).toBe('BUSY');
    await first;
  });
  test('rejects a verb outside ActionName without touching a dirty tree', async () => {
    fixture = await createFixture('dirty-and-conflicting');
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'unknown-1',
        base_sha: await headSha(fixture.alice),
        actions: ['git_cherry_pick' as never],
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('UNKNOWN_ACTION');
    expect(result.results).toEqual([]);
    expect(await porcelain(fixture.alice)).toBe('?? src/dirty.txt');
    expect(await stashList(fixture.alice)).toBe('');
  });

  test('an action that throws still restores the stash and reports ENGINE_ERROR', async () => {
    fixture = await createFixture('dirty-and-conflicting');
    const real = ACTIONS.git_fetch.run;
    ACTIONS.git_fetch.run = async () => {
      throw new Error('simulated engine fault');
    };
    try {
      const result = await apply(
        applyRequest(fixture, {
          action_id: 'throw-1',
          base_sha: await headSha(fixture.alice),
          actions: ['git_fetch'],
        }),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toBe('ENGINE_ERROR');
      expect(result.error_detail).toBe('simulated engine fault');
      expect(result.rolled_back).toBe(true);
    } finally {
      ACTIONS.git_fetch.run = real;
    }
    expect(await porcelain(fixture.alice)).toBe('?? src/dirty.txt');
    expect(await stashList(fixture.alice)).toBe('');
  });
  test('restores a branch after rolling back a conflicted rebase', async () => {
    fixture = await createFixture('conflicting');
    const snapshot = await takeSnapshot(fixture.alice, 'rebase-1');
    await execa('git', ['fetch', 'origin'], { cwd: fixture.alice });
    await execa('git', ['rebase', 'origin/main'], { cwd: fixture.alice, reject: false });
    expect(await branchName(fixture.alice)).toBe('HEAD');

    await rollback(fixture.alice, snapshot);

    expect(await branchName(fixture.alice)).toBe('main');
    expect(await headSha(fixture.alice)).toBe(snapshot.baseSha);
    expect(await porcelain(fixture.alice)).toBe('');
  });
  test('rebases cleanly on clean-behind and lands on the upstream commit', async () => {
    fixture = await createFixture('clean-behind');
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'rebase-clean',
        base_sha: await headSha(fixture.alice),
        actions: ['git_fetch', 'git_rebase'],
        context: { workdir: fixture.alice, remote: 'origin', branch: 'main' },
      }),
    );
    expect(result.status).toBe('success');
    expect(result.rolled_back).toBe(false);
    expect(await branchName(fixture.alice)).toBe('main');
    expect(await revListCount(fixture.alice, 'HEAD..origin/main')).toBe(0);
  });

  test('rolls a conflicted git_rebase back onto the branch with the dirty file intact', async () => {
    fixture = await createFixture('dirty-and-conflicting');
    const base_sha = await headSha(fixture.alice);
    const result = await apply(
      applyRequest(fixture, {
        action_id: 'rebase-conflict',
        base_sha,
        actions: ['git_fetch', 'git_rebase'],
        context: { workdir: fixture.alice, remote: 'origin', branch: 'main' },
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.rolled_back).toBe(true);
    expect(result.results.at(-1)?.action).toBe('git_rebase');
    expect(await branchName(fixture.alice)).toBe('main');
    expect(await headSha(fixture.alice)).toBe(base_sha);
    expect(await porcelain(fixture.alice)).toBe('?? src/dirty.txt');
    expect(await stashList(fixture.alice)).toBe('');
  });
});
