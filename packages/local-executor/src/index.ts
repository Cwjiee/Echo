/**
 * @echo/local-executor
 *
 * MCP (Model Context Protocol) agent exposing local execution tools.
 * Imported and invoked by the mac-agent when an approved_resolution payload arrives.
 *
 * Tools:
 *  - git_status, git_fetch, git_pull
 *  - npm_install
 *  - run_tests
 */

export { LocalExecutorMCP } from './mcp-server.js';
export { gitStatus, gitFetch, gitPull } from './tools/git.js';
export { npmInstall } from './tools/npm.js';
export { runTests } from './tools/tests.js';
export type { ExecutionResult, ActionName, ApprovedResolutionPayload } from './types.js';
