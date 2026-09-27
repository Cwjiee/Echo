import { execa } from 'execa';
import type { ExecutionResult } from '../types.js';

export async function runTests(workdir: string): Promise<ExecutionResult> {
  const start = Date.now();
  try {
    const { stdout, stderr, exitCode } = await execa('npm', ['test', '--', '--passWithNoTests'], {
      cwd: workdir,
      reject: false,
    });
    return {
      action: 'run_tests',
      success: exitCode === 0,
      stdout,
      stderr,
      exitCode: exitCode ?? 0,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      action: 'run_tests',
      success: false,
      stdout: '',
      stderr: String(err),
      exitCode: 1,
      durationMs: Date.now() - start,
    };
  }
}
