/**
 * LocalExecutorMCP — MCP server exposing execution tools.
 *
 * When running as a standalone MCP server (e.g. invoked by an AI agent),
 * it exposes the Git and NPM tools as callable MCP tools.
 *
 * Usage:
 *   node dist/mcp-server.js --workdir /path/to/project
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { gitStatus, gitFetch, gitPull } from './tools/git.js';
import { npmInstall } from './tools/npm.js';
import { runTests } from './tools/tests.js';

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
    // ── git_status ────────────────────────────────────────────────────────
    this.server.tool(
      'git_status',
      'Get the current git status of a repository',
      { workdir: z.string().describe('Absolute path to the git repository') },
      async ({ workdir }) => ({
        content: [{ type: 'text', text: JSON.stringify(await gitStatus(workdir), null, 2) }],
      }),
    );

    // ── git_fetch ─────────────────────────────────────────────────────────
    this.server.tool(
      'git_fetch',
      'Fetch latest changes from remote without merging',
      {
        workdir: z.string().describe('Absolute path to the git repository'),
        remote: z.string().default('origin'),
      },
      async ({ workdir, remote }) => ({
        content: [{ type: 'text', text: JSON.stringify(await gitFetch(workdir, remote), null, 2) }],
      }),
    );

    // ── git_pull ──────────────────────────────────────────────────────────
    this.server.tool(
      'git_pull',
      'Pull latest changes from remote (fetch + merge)',
      {
        workdir: z.string().describe('Absolute path to the git repository'),
        remote: z.string().default('origin'),
        branch: z.string().default('HEAD'),
      },
      async ({ workdir, remote, branch }) => ({
        content: [
          { type: 'text', text: JSON.stringify(await gitPull(workdir, remote, branch), null, 2) },
        ],
      }),
    );

    // ── npm_install ───────────────────────────────────────────────────────
    this.server.tool(
      'npm_install',
      'Run npm install in the specified directory',
      { workdir: z.string().describe('Absolute path to the project directory') },
      async ({ workdir }) => ({
        content: [{ type: 'text', text: JSON.stringify(await npmInstall(workdir), null, 2) }],
      }),
    );

    // ── run_tests ─────────────────────────────────────────────────────────
    this.server.tool(
      'run_tests',
      'Run the test suite in the specified directory',
      { workdir: z.string().describe('Absolute path to the project directory') },
      async ({ workdir }) => ({
        content: [{ type: 'text', text: JSON.stringify(await runTests(workdir), null, 2) }],
      }),
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[echo-executor] MCP server running on stdio');
  }
}

// ── Standalone entry point ────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const executor = new LocalExecutorMCP();
  executor.start().catch(console.error);
}
