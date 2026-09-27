/**
 * LocalExecutorMCP — MCP server exposing the execution leaves to local AI
 * tooling. Not on the sync path: the Mac Agent calls inspect() and apply()
 * directly. The tool names track the ActionName vocabulary in types.ts.
 *
 * Usage:
 *   node dist/mcp-server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { applyPatch, gitDiff, gitFetch, gitPull, gitRebase, gitStatus } from './tools/git.js';
import { installDeps } from './tools/npm.js';
import { runTests } from './tools/tests.js';
import type { ExecutionResult } from './types.js';

function report(result: ExecutionResult): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

const workdir = z.string().describe('Absolute path to the git repository');

export class LocalExecutorMCP {
  private server: McpServer;

  constructor() {
    this.server = new McpServer({
      name: 'echo-local-executor',
      version: '0.0.1',
    });
    this.registerTools();
  }

  private registerTools(): void {
    this.server.tool(
      'git_status',
      'Get the current git status of a repository',
      { workdir },
      async (args) => report(await gitStatus(args.workdir)),
    );

    this.server.tool(
      'git_fetch',
      'Fetch latest changes from remote without merging',
      { workdir, remote: z.string().default('origin') },
      async (args) => report(await gitFetch(args.workdir, args.remote)),
    );

    this.server.tool(
      'git_diff',
      'Diff the working tree, or two revisions when both are given',
      { workdir, from: z.string().optional(), to: z.string().optional() },
      async (args) => {
        const revisions = [args.from, args.to].filter((rev): rev is string => Boolean(rev));
        return report(await gitDiff(args.workdir, ...revisions));
      },
    );

    this.server.tool(
      'git_pull',
      'Pull latest changes from remote (fetch + merge)',
      { workdir, remote: z.string().optional(), branch: z.string().optional() },
      async (args) => report(await gitPull(args.workdir, args.remote, args.branch)),
    );

    this.server.tool(
      'git_rebase',
      'Rebase the current branch onto its upstream counterpart',
      { workdir, remote: z.string().optional(), branch: z.string().optional() },
      async (args) => report(await gitRebase(args.workdir, args.remote, args.branch)),
    );

    this.server.tool(
      'apply_patch',
      'Apply a unified diff with git apply --3way and commit it',
      {
        workdir,
        patch: z.string().describe('Unified diff in git diff format, with a/ and b/ prefixes'),
        action_id: z.string().describe('Idempotency key, named in the commit message'),
      },
      async (args) => report(await applyPatch(args.workdir, args.patch, args.action_id)),
    );

    this.server.tool(
      'install_deps',
      'Install dependencies with the package manager the lockfile selects',
      { workdir },
      async (args) => report(await installDeps(args.workdir)),
    );

    this.server.tool(
      'run_tests',
      'Run the detected test suite, or skip when the project has none',
      { workdir },
      async (args) => report(await runTests(args.workdir)),
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[echo-executor] MCP server running on stdio');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const executor = new LocalExecutorMCP();
  executor.start().catch(console.error);
}
