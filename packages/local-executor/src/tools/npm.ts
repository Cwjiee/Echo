/**
 * Dependency installation. The package manager is read off the lockfile rather
 * than configured, so a repo that switches managers needs no engine change.
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from '../exec.js';
import type { ExecutionResult } from '../types.js';

interface PackageManager {
  lockfile: string;
  command: string;
  args: string[];
}

const NPM: PackageManager = { lockfile: 'package-lock.json', command: 'npm', args: ['install'] };

const PACKAGE_MANAGERS: readonly PackageManager[] = [
  NPM,
  { lockfile: 'pnpm-lock.yaml', command: 'pnpm', args: ['install'] },
  { lockfile: 'yarn.lock', command: 'yarn', args: ['install'] },
  { lockfile: 'bun.lock', command: 'bun', args: ['install'] },
  { lockfile: 'bun.lockb', command: 'bun', args: ['install'] },
];

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function detectPackageManager(workdir: string): Promise<PackageManager> {
  for (const manager of PACKAGE_MANAGERS) {
    if (await exists(path.join(workdir, manager.lockfile))) return manager;
  }
  return NPM;
}

export async function installDeps(workdir: string): Promise<ExecutionResult> {
  const manager = await detectPackageManager(workdir);
  return runCommand({
    action: 'install_deps',
    command: manager.command,
    args: manager.args,
    cwd: workdir,
  });
}
