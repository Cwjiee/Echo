/**
 * Executor Bridge
 *
 * Connects the mac-agent to the @echo/local-executor package. Sequencing,
 * snapshots, rollback and stash handling all live in the engine's apply(), so
 * this is a thin hand-off rather than a loop over actions.
 *
 * Dynamic import() is required because @echo/local-executor is ESM-only
 * (execa, @modelcontextprotocol/sdk). The mac-agent main process is CJS, so
 * require() cannot load it.
 */

import type { ApplyRequest, ApplyResult } from '@echo/local-executor';

export async function executeResolution(payload: ApplyRequest): Promise<ApplyResult> {
  const { apply } = await import('@echo/local-executor');

  console.log(`[executor] Applying ${payload.action_id}: ${payload.actions.join(', ')}`);

  const result = await apply(payload, (event) => {
    console.log(
      `[executor] ${event.index + 1}/${event.total} ${event.result.action}: ` +
        `${event.result.success ? 'OK' : 'FAILED'}`,
    );
  });

  console.log(`[executor] ${payload.action_id}: ${result.status}`);
  return result;
}
