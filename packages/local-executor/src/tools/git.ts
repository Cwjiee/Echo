/**
 * Git operation wrappers.
 *
 * Each function runs in the specified workdir and returns a structured ExecutionResult.
 * All operations are intentionally non-destructive unless explicitly approved.
 */

import { execa } from 'execa';
import type { ExecutionResult } from '../types.js';

async function runGit(
  args: string[],
  workdir: string,
  action: ExecutionResult['action'],
): Promise<ExecutionResult> {
  const start = Date.now();
  try {
    const { stdout, stderr, exitCode } = await execa('git', args, {
      cwd: workdir,
      reject: false,
    });
    return {
      action,
      success: exitCode === 0,
      stdout,
      stderr,
      exitCode: exitCode ?? 0,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      action,
      success: false,
      stdout: '',
      stderr: String(err),
      exitCode: 1,
      durationMs: Date.now() - start,
    };
  }
}

export async function gitStatus(workdir: string): Promise<ExecutionResult> {
  return runGit(['status', '--porcelain'], workdir, 'git_status');
}

export async function gitFetch(workdir: string, remote = 'origin'): Promise<ExecutionResult> {
  return runGit(['fetch', remote], workdir, 'git_fetch');
}

export async function gitPull(
  workdir: string,
  remote = 'origin',
  branch = 'HEAD',
): Promise<ExecutionResult> {
  return runGit(['pull', remote, branch], workdir, 'git_pull');
}
