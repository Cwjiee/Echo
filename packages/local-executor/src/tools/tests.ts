/**
 * Test execution. A repository with no recognisable runner is not a failure:
 * the engine reports success and spawns nothing.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCommand, skippedResult } from '../exec.js';
import type { ExecutionResult } from '../types.js';

interface TestRunner {
  command: string;
  args: string[];
}

const NPM_TEST: TestRunner = { command: 'npm', args: ['test'] };
const PYTEST: TestRunner = { command: 'pytest', args: [] };

async function readText(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

function hasTestScript(packageJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return false;
  const test = (scripts as { test?: unknown }).test;
  return typeof test === 'string' && test.trim() !== '';
}

export async function detectTestRunner(workdir: string): Promise<TestRunner | null> {
  const packageJson = await readText(path.join(workdir, 'package.json'));
  if (packageJson !== null && hasTestScript(packageJson)) return NPM_TEST;

  if ((await readText(path.join(workdir, 'pytest.ini'))) !== null) return PYTEST;

  const pyproject = await readText(path.join(workdir, 'pyproject.toml'));
  if (pyproject !== null && pyproject.includes('pytest')) return PYTEST;

  return null;
}

export async function runTests(workdir: string): Promise<ExecutionResult> {
  const runner = await detectTestRunner(workdir);
  if (!runner) return skippedResult('run_tests', 'no test runner was detected; skipping tests\n');
  return runCommand({
    action: 'run_tests',
    command: runner.command,
    args: runner.args,
    cwd: workdir,
  });
}
