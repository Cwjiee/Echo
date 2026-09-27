/**
 * Test fixture rig for @echo/local-executor.
 *
 * Builds real git repositories on disk (a bare origin plus alice and bob
 * clones) so tests exercise actual git behavior instead of mocks. Scenarios
 * are data, not branches: createFixture reads SCENARIOS and applies the same
 * sequence of git operations regardless of which row it got.
 */

import { execa } from 'execa';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type ScenarioName = 'up-to-date' | 'clean-behind' | 'conflicting' | 'dirty-and-conflicting';

export interface FileEdit {
  path: string;
  content: string;
}

export interface ScenarioSpec {
  upstreamCommits: FileEdit[][];
  localCommits: FileEdit[][];
  localDirty: FileEdit[];
}

export interface Fixture {
  root: string;
  origin: string;
  alice: string;
  bob: string;
  slug: string;
  cleanup(): Promise<void>;
}

const BASE_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'fixture-repo',
      version: '0.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    },
    null,
    2,
  ) + '\n';

function appJs(lineThree: number): string {
  return (
    [
      'function lineOne() {',
      '  return 1;',
      '}',
      '',
      'function lineTwo() {',
      '  return 2;',
      '}',
      '',
      'function lineThree() {',
      `  return ${lineThree};`,
      '}',
      '',
      'function lineFour() {',
      '  return 4;',
      '}',
      '',
      'function lineFive() {',
      '  return 5;',
      '}',
      '',
      'module.exports = { lineOne, lineTwo, lineThree, lineFour, lineFive };',
    ].join('\n') + '\n'
  );
}

const BASE_APP_JS = appJs(3);
const BOB_APP_JS = appJs(30);
const ALICE_APP_JS = appJs(300);

const BASE_FILES: FileEdit[] = [
  { path: 'package.json', content: BASE_PACKAGE_JSON },
  { path: 'src/app.js', content: BASE_APP_JS },
];

export const SCENARIOS: Record<ScenarioName, ScenarioSpec> = {
  'up-to-date': {
    upstreamCommits: [],
    localCommits: [],
    localDirty: [],
  },
  'clean-behind': {
    upstreamCommits: [[{ path: 'src/util.js', content: 'module.exports.util = 1;\n' }]],
    localCommits: [],
    localDirty: [],
  },
  conflicting: {
    upstreamCommits: [[{ path: 'src/app.js', content: BOB_APP_JS }]],
    localCommits: [[{ path: 'src/app.js', content: ALICE_APP_JS }]],
    localDirty: [],
  },
  'dirty-and-conflicting': {
    upstreamCommits: [[{ path: 'src/app.js', content: BOB_APP_JS }]],
    localCommits: [[{ path: 'src/app.js', content: ALICE_APP_JS }]],
    localDirty: [{ path: 'src/dirty.txt', content: 'work in progress\n' }],
  },
};

export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execa('git', args, { cwd, reject: false });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
}

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${result.stderr}`);
  }
}

async function configureClone(dir: string): Promise<void> {
  await git(['config', 'user.email', 'echo@test.local'], dir);
  await git(['config', 'user.name', 'Echo Test'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
}

async function writeEdits(dir: string, edits: FileEdit[]): Promise<void> {
  for (const edit of edits) {
    const target = path.join(dir, edit.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, edit.content);
  }
}

async function commitEdits(dir: string, edits: FileEdit[], message: string): Promise<void> {
  await writeEdits(dir, edits);
  await git(['add', '-A'], dir);
  await git(['commit', '-m', message], dir);
}

async function seedOrigin(root: string): Promise<string> {
  const origin = path.join(root, 'origin.git');
  await git(['init', '--bare', '-b', 'main', origin], root);

  const seed = path.join(root, 'seed');
  await git(['clone', origin, seed], root);
  await configureClone(seed);
  await commitEdits(seed, BASE_FILES, 'initial commit');
  await git(['push', '-u', 'origin', 'main'], seed);
  await rm(seed, { recursive: true, force: true });

  return origin;
}

export async function buildFixture(scenario: ScenarioName, root: string): Promise<Fixture> {
  const spec = SCENARIOS[scenario];
  const origin = await seedOrigin(root);

  const alice = path.join(root, 'alice');
  const bob = path.join(root, 'bob');
  await git(['clone', origin, alice], root);
  await git(['clone', origin, bob], root);
  await configureClone(alice);
  await configureClone(bob);

  for (const [i, edits] of spec.upstreamCommits.entries()) {
    await commitEdits(bob, edits, `upstream commit ${i + 1}`);
  }
  await git(['push', 'origin', 'main'], bob);

  for (const [i, edits] of spec.localCommits.entries()) {
    await commitEdits(alice, edits, `local commit ${i + 1}`);
  }

  await writeEdits(alice, spec.localDirty);

  return {
    root,
    origin,
    alice,
    bob,
    slug: 'echo-test/fixture-repo',
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createFixture(scenario: ScenarioName): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'echo-fixture-'));
  return buildFixture(scenario, root);
}
