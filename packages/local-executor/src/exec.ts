/**
 * Every subprocess the engine spawns goes through this file, so the per-action
 * timeout, the process-tree kill, and the output truncation rules hold
 * everywhere rather than being re-derived at each call site.
 */

import { execa } from 'execa';
import {
  ACTION_TIMEOUT_MS,
  OUTPUT_HEAD_TAIL_BYTES,
  TRUNCATION_MARKER,
  type ActionName,
  type ExecutionResult,
} from './types.js';

/** Grace period between SIGTERM and SIGKILL when an action overruns its budget. */
const FORCE_KILL_AFTER_MS = 5_000;

/** Budget for the read-only git plumbing behind inspect() and the snapshot. */
const PLUMBING_TIMEOUT_MS = 60_000;

export interface CommandSpec {
  action: ActionName;
  command: string;
  args: string[];
  cwd: string;
}

interface TruncatedText {
  text: string;
  truncated: boolean;
}

function truncateHeadTail(value: string, headTailBytes: number): TruncatedText {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= headTailBytes * 2) return { text: value, truncated: false };
  const head = bytes.subarray(0, headTailBytes).toString('utf8');
  const tail = bytes.subarray(bytes.byteLength - headTailBytes).toString('utf8');
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, truncated: true };
}

export async function runCommand(spec: CommandSpec): Promise<ExecutionResult> {
  const start = Date.now();
  try {
    const result = await execa(spec.command, spec.args, {
      cwd: spec.cwd,
      reject: false,
      timeout: ACTION_TIMEOUT_MS[spec.action],
      killSignal: 'SIGTERM',
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    });
    const stdout = truncateHeadTail(result.stdout, OUTPUT_HEAD_TAIL_BYTES);
    const stderr = truncateHeadTail(result.stderr, OUTPUT_HEAD_TAIL_BYTES);
    return {
      action: spec.action,
      success: !result.failed,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: result.exitCode ?? (result.failed ? 1 : 0),
      durationMs: Date.now() - start,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: result.timedOut,
    };
  } catch (error) {
    return {
      action: spec.action,
      success: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      durationMs: Date.now() - start,
      truncated: false,
      timedOut: false,
    };
  }
}

/** An ExecutionResult for an action that deliberately spawned nothing. */
export function skippedResult(action: ActionName, stdout: string): ExecutionResult {
  return {
    action,
    success: true,
    stdout,
    stderr: '',
    exitCode: 0,
    durationMs: 0,
    truncated: false,
    timedOut: false,
  };
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Read-only git plumbing for inspect() and the snapshot. Separate from
 * runCommand because these reads are not actions: they carry no ActionName and
 * diff_stat in particular must never be truncated.
 */
export async function captureGit(cwd: string, args: string[]): Promise<CaptureResult> {
  try {
    const result = await execa('git', args, {
      cwd,
      reject: false,
      timeout: PLUMBING_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  } catch (error) {
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
  }
}
