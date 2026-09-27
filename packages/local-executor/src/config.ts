/**
 * Resolves a GitHub repository slug to a local clone, using ~/.echo/config.json
 * and the development environment overrides documented in CONTRACT.md.
 */

import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureGit } from './exec.js';
import { DEFAULT_CONFIG, type EchoConfig } from './types.js';

const CONFIG_PATH = path.join(os.homedir(), '.echo', 'config.json');

function expandHome(target: string): string {
  return target === '~' || target.startsWith('~/')
    ? path.join(os.homedir(), target.slice(1))
    : target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}

export async function loadConfig(): Promise<Required<EchoConfig>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch {
    parsed = undefined;
  }
  const file = isRecord(parsed) ? parsed : {};

  const envRoots = process.env.ECHO_SCAN_ROOTS?.split(':').filter(Boolean);
  const envDepth = Number(process.env.ECHO_MAX_DEPTH);

  return {
    scanRoots: envRoots?.length ? envRoots : (asStringArray(file.scanRoots) ?? DEFAULT_CONFIG.scanRoots),
    maxDepth: Number.isFinite(envDepth) && envDepth >= 0
      ? envDepth
      : typeof file.maxDepth === 'number'
        ? file.maxDepth
        : DEFAULT_CONFIG.maxDepth,
    repoOverrides: asStringMap(file.repoOverrides) ?? DEFAULT_CONFIG.repoOverrides,
  };
}

/** Reduces git@host:owner/repo.git and https://host/owner/repo.git to owner/repo. */
export function normaliseRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = /^[^/@]+@[^/:]+:(.+)$/.exec(trimmed);
  if (ssh?.[1] !== undefined) return ssh[1].toLowerCase();
  try {
    return new URL(trimmed).pathname.replace(/^\/+/, '').toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * Synchronous on purpose. apply() keys its per-repository lock on this path and
 * must take the lock without yielding, so normalisation cannot be an await. On
 * macOS mkdtemp hands back /var/folders/... while the same directory realpaths
 * to /private/var/folders/..., and two spellings of one repo would be two locks.
 */
function normalisePath(target: string): string | null {
  try {
    return realpathSync(expandHome(target));
  } catch {
    return null;
  }
}

async function originSlug(repoDir: string): Promise<string | null> {
  const remote = await captureGit(repoDir, ['remote', 'get-url', 'origin']);
  return remote.exitCode === 0 && remote.stdout.trim() !== ''
    ? normaliseRemote(remote.stdout)
    : null;
}

async function scanForSlug(dir: string, depth: number, slug: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  if (entries.some((entry) => entry.name === '.git')) {
    return (await originSlug(dir)) === slug ? dir : null;
  }
  if (depth <= 0) return null;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const found = await scanForSlug(path.join(dir, entry.name), depth - 1, slug);
    if (found) return found;
  }
  return null;
}

export async function resolveRepoPath(slug: string, override?: string): Promise<string | null> {
  const explicit = override ?? process.env.ECHO_REPO_PATH;
  if (explicit) return normalisePath(explicit);

  const config = await loadConfig();
  const mapped = config.repoOverrides[slug];
  if (mapped) return normalisePath(mapped);

  const wanted = normaliseRemote(slug);
  for (const root of config.scanRoots) {
    const found = await scanForSlug(expandHome(root), config.maxDepth, wanted);
    if (found) return normalisePath(found);
  }
  return null;
}
