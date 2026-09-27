/**
 * Executor Bridge
 *
 * Connects the mac-agent to the @echo/local-executor package.
 * When an 'approved_resolution' payload arrives over WebSocket,
 * this module runs the requested actions sequentially and returns results.
 * Aborts the sequence on first failure to prevent cascading issues.
 */

import type {
  ActionName,
  ApprovedResolutionPayload,
  ExecutionResult,
} from '@echo/local-executor';
import path from 'path';
import os from 'os';

const DEFAULT_WORKDIR = os.homedir();

export async function executeResolution(
  payload: ApprovedResolutionPayload,
): Promise<ExecutionResult[]> {
  const executor = await import('@echo/local-executor');

  const actionMap: Record<ActionName, (workdir: string) => Promise<ExecutionResult>> = {
    git_status: (w) => executor.gitStatus(w),
    git_fetch: (w) => executor.gitFetch(w),
    git_pull: (w) => executor.gitPull(w),
    npm_install: (w) => executor.npmInstall(w),
    run_tests: (w) => executor.runTests(w),
  };
  const workdir = payload.context.workdir
    ? path.resolve(payload.context.workdir)
    : DEFAULT_WORKDIR;

  console.log(`[executor] Running ${payload.actions.join(', ')} in ${workdir}`);

  const results: ExecutionResult[] = [];

  for (const action of payload.actions) {
    const fn = actionMap[action];
    if (!fn) {
      console.warn(`[executor] Unknown action: ${action}`);
      continue;
    }

    const result = await fn(workdir);
    results.push(result);
    console.log(`[executor] ${action}: ${result.success ? 'OK' : 'FAILED'}`);

    if (!result.success) {
      console.error(`[executor] Aborting after failed: ${action}`);
      break;
    }
  }

  return results;
}
