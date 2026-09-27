/**
 * Executable spec for the leaf tools: which package manager and test runner get
 * chosen, and the two output rules in exec.ts that every action inherits.
 *
 * These are the behaviors a developer sees when a sync touches an unfamiliar
 * repository. Detection picking wrong installs the wrong lockfile, a missing
 * skip path fails a repo that simply has no tests, and the truncation and
 * timeout rules are the only thing standing between a runaway command and the
 * chat thread.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/exec.js';
import { detectPackageManager } from '../src/tools/npm.js';
import { detectTestRunner, runTests } from '../src/tools/tests.js';
import { ACTION_TIMEOUT_MS, OUTPUT_HEAD_TAIL_BYTES, TRUNCATION_MARKER } from '../src/types.js';

const created: string[] = [];

/** A bare directory with the given files, cleaned up after the test. */
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'echo-tools-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

/** Runs node itself, so the assertions do not depend on what is installed on the machine. */
function node(action: 'git_status' | 'run_tests', script: string, cwd: string) {
  return runCommand({ action, command: process.execPath, args: ['-e', script], cwd });
}

afterEach(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
  created.length = 0;
});

describe('package manager detection', () => {
  const LOCKFILES: ReadonlyArray<[string, string]> = [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ];

  test.each(LOCKFILES)('%s selects %s install', async (lockfile, command) => {
    const dir = await repoWith({ [lockfile]: '' });
    const manager = await detectPackageManager(dir);
    expect(manager.command).toBe(command);
    expect(manager.args).toEqual(['install']);
  });

  test('a repository with no lockfile falls back to npm', async () => {
    const dir = await repoWith({ 'package.json': '{}' });
    expect((await detectPackageManager(dir)).command).toBe('npm');
  });

  // Pins current precedence rather than endorsing it. A repository that migrated
  // from npm to pnpm and left package-lock.json behind gets npm here, which is
  // the wrong answer; changing it is a behavior change, not a test.
  test('package-lock.json wins when several lockfiles are present', async () => {
    const dir = await repoWith({ 'package-lock.json': '', 'pnpm-lock.yaml': '', 'yarn.lock': '' });
    expect((await detectPackageManager(dir)).command).toBe('npm');
  });
});

describe('test runner detection', () => {
  test('package.json with a test script selects npm test', async () => {
    const dir = await repoWith({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
    expect(await detectTestRunner(dir)).toEqual({ command: 'npm', args: ['test'] });
  });

  test('pytest.ini selects pytest', async () => {
    const dir = await repoWith({ 'pytest.ini': '[pytest]\n' });
    expect(await detectTestRunner(dir)).toEqual({ command: 'pytest', args: [] });
  });

  test('pyproject.toml naming pytest selects pytest', async () => {
    const dir = await repoWith({ 'pyproject.toml': '[tool.pytest.ini_options]\n' });
    expect(await detectTestRunner(dir)).toEqual({ command: 'pytest', args: [] });
  });

  test('a package.json with an empty test script is not a runner', async () => {
    const dir = await repoWith({ 'package.json': JSON.stringify({ scripts: { test: '  ' } }) });
    expect(await detectTestRunner(dir)).toBeNull();
  });

  test('unparseable package.json is not a runner rather than a crash', async () => {
    const dir = await repoWith({ 'package.json': '{ this is not json' });
    expect(await detectTestRunner(dir)).toBeNull();
  });
});

describe('run_tests skip path', () => {
  test('a repository with no runner succeeds without spawning anything', async () => {
    const dir = await repoWith({ 'README.md': 'no tests here\n' });
    const result = await runTests(dir);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('no test runner was detected; skipping tests\n');
    expect(result.durationMs).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test('a repository with a test script actually runs it', async () => {
    const dir = await repoWith({
      'package.json': JSON.stringify({
        name: 'runner-fixture',
        scripts: { test: 'node -e "console.log(\'ran the suite\')"' },
      }),
    });
    const result = await runTests(dir);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('ran the suite');
  });
});

describe('output truncation', () => {
  test('output inside the budget is passed through untouched', async () => {
    const dir = await repoWith({});
    const result = await node('run_tests', "process.stdout.write('x'.repeat(100))", dir);
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe('x'.repeat(100));
  });

  test('oversized stdout keeps the head and the tail with a marker between', async () => {
    const dir = await repoWith({});
    const script = `process.stdout.write('HEAD' + 'a'.repeat(40000) + 'TAIL')`;
    const result = await node('run_tests', script, dir);

    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith('HEAD')).toBe(true);
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout).toContain(TRUNCATION_MARKER);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(
      OUTPUT_HEAD_TAIL_BYTES * 2 + Buffer.byteLength(TRUNCATION_MARKER, 'utf8'),
    );
  });

  test('oversized stderr is truncated on its own and flags the result', async () => {
    const dir = await repoWith({});
    const script = `process.stderr.write('E'.repeat(40000)); process.stdout.write('short')`;
    const result = await node('run_tests', script, dir);

    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('short');
    expect(result.stderr).toContain(TRUNCATION_MARKER);
  });
});

describe('action timeout', () => {
  test('a command that overruns its budget is killed and reported as timed out', async () => {
    const dir = await repoWith({});
    const original = ACTION_TIMEOUT_MS.git_status;
    // Shrinking the real budget beats waiting out the 10s one. exec.ts reads the
    // table per call, so this exercises the same path a genuine overrun takes.
    ACTION_TIMEOUT_MS.git_status = 200;
    try {
      const result = await node('git_status', 'setTimeout(() => {}, 30000)', dir);
      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);
      expect(result.action).toBe('git_status');
      expect(result.durationMs).toBeLessThan(10_000);
    } finally {
      ACTION_TIMEOUT_MS.git_status = original;
    }
  });
});
