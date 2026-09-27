/**
 * Proves the rig itself: every scenario in fixtures.ts produces the real git
 * state its name promises. No engine involved.
 */

import { describe, test, expect } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, runGit } from './fixtures.js';

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe('fixture rig', () => {
  test('conflicting produces a genuine merge conflict', async () => {
    const fixture = await createFixture('conflicting');
    try {
      await runGit(['fetch'], fixture.alice);
      const merge = await runGit(['merge', 'origin/main'], fixture.alice);
      expect(merge.exitCode).not.toBe(0);
      const content = await readFile(path.join(fixture.alice, 'src/app.js'), 'utf8');
      expect(content).toContain('<<<<<<<');
    } finally {
      await fixture.cleanup();
    }
  });

  test('clean-behind is exactly one commit behind and merges cleanly', async () => {
    const fixture = await createFixture('clean-behind');
    try {
      await runGit(['fetch'], fixture.alice);
      const count = await runGit(['rev-list', '--count', 'HEAD..origin/main'], fixture.alice);
      expect(count.stdout.trim()).toBe('1');
      const merge = await runGit(['merge', 'origin/main'], fixture.alice);
      expect(merge.exitCode).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test('up-to-date is zero commits behind', async () => {
    const fixture = await createFixture('up-to-date');
    try {
      await runGit(['fetch'], fixture.alice);
      const count = await runGit(['rev-list', '--count', 'HEAD..origin/main'], fixture.alice);
      expect(count.stdout.trim()).toBe('0');
    } finally {
      await fixture.cleanup();
    }
  });

  test('dirty-and-conflicting leaves exactly one dirty path', async () => {
    const fixture = await createFixture('dirty-and-conflicting');
    try {
      const status = await runGit(['status', '--porcelain'], fixture.alice);
      expect(status.stdout.trim()).toBe('?? src/dirty.txt');
    } finally {
      await fixture.cleanup();
    }
  });

  test('cleanup removes the fixture root', async () => {
    const fixture = await createFixture('up-to-date');
    const root = fixture.root;
    await fixture.cleanup();
    expect(await exists(root)).toBe(false);
  });
});
