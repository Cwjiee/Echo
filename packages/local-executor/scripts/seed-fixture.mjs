#!/usr/bin/env node
/**
 * Seeds a named directory with one of the fixture rig's scenarios, so the
 * same conflict the test suite exercises can be pushed to the real GitHub
 * demo repo and rehearsed by hand.
 *
 * Usage: node scripts/seed-fixture.mjs --scenario conflicting --out <dir>
 */

import { tsImport } from 'tsx/esm/api';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const { SCENARIOS, buildFixture } = await tsImport('../test/fixtures.ts', import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scenario') args.scenario = argv[(i += 1)];
    else if (argv[i] === '--out') args.out = argv[(i += 1)];
  }
  return args;
}

const { scenario, out } = parseArgs(process.argv.slice(2));
const names = Object.keys(SCENARIOS);

if (!scenario || !names.includes(scenario)) {
  console.error(`--scenario must be one of: ${names.join(', ')}`);
  process.exit(1);
}
if (!out) {
  console.error('--out <dir> is required');
  process.exit(1);
}

const root = path.resolve(out);
await mkdir(root, { recursive: true });
const fixture = await buildFixture(scenario, root);

console.log(`scenario: ${scenario}`);
console.log(`root:     ${fixture.root}`);
console.log(`origin:   ${fixture.origin}`);
console.log(`alice:    ${fixture.alice}`);
console.log(`bob:      ${fixture.bob}`);
console.log(`slug:     ${fixture.slug}`);
