/**
 * Second round trip: execute an approved resolution against a local clone, with
 * a restore point taken before the first mutation and never a dropped stash.
 */

import { ACTIONS, type ActionContext } from './actions.js';
import { resolveRepoPath } from './config.js';
import { captureGit } from './exec.js';
import { restoreStash, rollback, takeSnapshot } from './snapshot.js';
import { checkPatch } from './tools/git.js';
import {
  PROTOCOL_VERSION,
  type ActionProgressEvent,
  type ApplyErrorCode,
  type ApplyRequest,
  type ApplyResult,
  type ExecutionResult,
} from './types.js';

export type ProgressListener = (event: ActionProgressEvent) => void;

const replayCache = new Map<string, ApplyResult>();

/** Resolved repository paths with an apply in flight. Keyed on the realpath. */
const inFlight = new Set<string>();

/** Repository slugs with an apply in flight, claimed before path resolution. */
const inFlightSlugs = new Set<string>();

interface GuardContext {
  request: ApplyRequest;
  workdir: string;
}

type Guard = (ctx: GuardContext) => Promise<ApplyErrorCode | null>;

const GUARDS: readonly Guard[] = [
  async ({ request }) =>
    request.protocol_version === PROTOCOL_VERSION ? null : 'PROTOCOL_MISMATCH',

  async ({ request }) =>
    request.actions.every((name) => name in ACTIONS) ? null : 'UNKNOWN_ACTION',

  async ({ request }) =>
    request.actions.includes('apply_patch') && !request.patch ? 'PATCH_MISSING' : null,

  async ({ request, workdir }) => {
    const head = await captureGit(workdir, ['rev-parse', 'HEAD']);
    return head.stdout.trim() === request.base_sha ? null : 'STALE_STATE';
  },

  async ({ request, workdir }) => {
    if (!request.actions.includes('apply_patch') || !request.patch) return null;
    const check = await checkPatch(workdir, request.patch);
    return check.success ? null : 'PATCH_REJECTED';
  },
];

function rejected(request: ApplyRequest, error: ApplyErrorCode): ApplyResult {
  return {
    protocol_version: PROTOCOL_VERSION,
    action_id: request.action_id,
    repository: request.repository,
    status: 'rejected',
    error,
    results: [],
    rolled_back: false,
    replayed: false,
  };
}

async function execute(
  request: ApplyRequest,
  workdir: string,
  onProgress?: ProgressListener,
): Promise<ApplyResult> {
  for (const guard of GUARDS) {
    const error = await guard({ request, workdir });
    if (error) return rejected(request, error);
  }

  const snapshot = await takeSnapshot(workdir, request.action_id);

  const results: ExecutionResult[] = [];
  let patchCommitSha: string | undefined;
  let rolledBack = false;
  const ctx: ActionContext = {
    workdir,
    request,
    onPatchCommit: (sha) => {
      patchCommitSha = sha;
    },
  };

  // The stash is taken above, so every path out of here has to reach
  // restoreStash. An action that throws rather than returning a failed result
  // would otherwise leave the developer's work in a stash with no ApplyResult
  // to tell anyone it happened.
  let engineError: string | undefined;

  try {
    for (const [index, name] of request.actions.entries()) {
      const spec = ACTIONS[name];
      const result = await spec.run(ctx);
      results.push(result);
      onProgress?.({
        action_id: request.action_id,
        repository: request.repository,
        index,
        total: request.actions.length,
        result,
      });
      if (result.success) continue;

      if (spec.rollbackOnFailure) {
        await rollback(workdir, snapshot);
        rolledBack = true;
      }
      break;
    }
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
    await rollback(workdir, snapshot);
    rolledBack = true;
  }

  const retained = await restoreStash(workdir, snapshot);
  const failed = engineError !== undefined || results.some((result) => !result.success);

  return {
    protocol_version: PROTOCOL_VERSION,
    action_id: request.action_id,
    repository: request.repository,
    status: failed ? 'failed' : 'success',
    ...(engineError ? { error: 'ENGINE_ERROR' as const, error_detail: engineError } : {}),
    results,
    rolled_back: rolledBack,
    ...(patchCommitSha ? { patch_commit_sha: patchCommitSha } : {}),
    ...(retained ? { stash_retained: retained } : {}),
    replayed: false,
  };
}

export async function apply(
  request: ApplyRequest,
  onProgress?: ProgressListener,
): Promise<ApplyResult> {
  const cached = replayCache.get(request.action_id);
  if (cached) return { ...cached, replayed: true };

  // Claimed in the synchronous prefix of this function, before the first await.
  // Path resolution below scans the filesystem, and fs callbacks do not resolve
  // in submission order, so a lock taken only after it would let two concurrent
  // requests for one repository both pass the check.
  if (inFlightSlugs.has(request.repository)) return rejected(request, 'BUSY');
  inFlightSlugs.add(request.repository);

  try {
    const workdir = await resolveRepoPath(request.repository, request.context?.workdir);
    if (!workdir) return rejected(request, 'REPO_NOT_FOUND');

    // Two slugs can name one clone, so the realpath is locked as well.
    if (inFlight.has(workdir)) return rejected(request, 'BUSY');
    inFlight.add(workdir);

    try {
      const result = await execute(request, workdir, onProgress);
      // A rejection executed nothing. Caching it would make a retry under the
      // same action_id, after the backend re-inspects or naviin regenerates the
      // patch, fail forever on the stale verdict.
      if (result.status !== 'rejected') replayCache.set(request.action_id, result);
      return result;
    } finally {
      inFlight.delete(workdir);
    }
  } finally {
    inFlightSlugs.delete(request.repository);
  }
}
