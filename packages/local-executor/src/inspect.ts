/**
 * First round trip: describe local and upstream state so the Cloud AI Agent can
 * propose a resolution against a known HEAD.
 */

import { resolveRepoPath } from './config.js';
import { captureGit } from './exec.js';
import { gitFetch } from './tools/git.js';
import {
  MAX_DIFF_BYTES,
  PROTOCOL_VERSION,
  TRUNCATION_MARKER,
  type InspectReport,
  type InspectRequest,
} from './types.js';

/** Paths from `git status --porcelain`, including untracked and the target of a rename. */
function porcelainPaths(status: string): string[] {
  return status
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const entry = line.slice(3);
      const arrow = entry.indexOf(' -> ');
      return arrow === -1 ? entry : entry.slice(arrow + 4);
    });
}

function capDiff(text: string): { text: string; truncated: boolean; original_bytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= MAX_DIFF_BYTES) {
    return { text, truncated: false, original_bytes: bytes.byteLength };
  }
  return {
    text: bytes.subarray(0, MAX_DIFF_BYTES).toString('utf8') + TRUNCATION_MARKER,
    truncated: true,
    original_bytes: bytes.byteLength,
  };
}

export async function inspect(request: InspectRequest): Promise<InspectReport> {
  const repoPath = await resolveRepoPath(request.repository, request.workdir);
  if (!repoPath) throw new Error(`REPO_NOT_FOUND: no local clone for ${request.repository}`);

  await gitFetch(repoPath);

  const branch =
    request.branch ?? (await captureGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const upstreamRef = `origin/${branch}`;

  const headSha = (await captureGit(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
  const upstreamSha = (await captureGit(repoPath, ['rev-parse', upstreamRef])).stdout.trim();
  const mergeBase = (await captureGit(repoPath, ['merge-base', 'HEAD', upstreamRef])).stdout.trim();

  const behind = await captureGit(repoPath, ['rev-list', '--count', `HEAD..${upstreamRef}`]);
  const ahead = await captureGit(repoPath, ['rev-list', '--count', `${upstreamRef}..HEAD`]);
  const status = await captureGit(repoPath, ['status', '--porcelain']);
  const diffStat = await captureGit(repoPath, ['diff', '--stat', mergeBase, upstreamSha]);
  const diff = await captureGit(repoPath, ['diff', mergeBase, upstreamSha]);

  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: request.request_id,
    repository: request.repository,
    path: repoPath,
    branch,
    head_sha: headSha,
    upstream_sha: upstreamSha,
    merge_base: mergeBase,
    ahead: Number(ahead.stdout.trim()) || 0,
    behind: Number(behind.stdout.trim()) || 0,
    dirty: porcelainPaths(status.stdout),
    diff_stat: diffStat.stdout,
    diff: capDiff(diff.stdout),
  };
}
