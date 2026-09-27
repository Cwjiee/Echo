/**
 * @echo/local-executor
 *
 * The Local Execution Engine. inspect() and apply() are the sync path the Mac
 * Agent calls; the leaf tools and LocalExecutorMCP wrap the same commands for
 * local AI tooling. See CONTRACT.md.
 */

export { inspect } from './inspect.js';
export { apply, type ProgressListener } from './apply.js';
export { LocalExecutorMCP } from './mcp-server.js';
export {
  gitStatus,
  gitFetch,
  gitDiff,
  gitPull,
  gitRebase,
  applyPatch,
  checkPatch,
} from './tools/git.js';
export { installDeps } from './tools/npm.js';
export { runTests } from './tools/tests.js';
export type {
  ExecutionResult,
  ActionName,
  ActionProgressEvent,
  ApplyRequest,
  ApplyResult,
  InspectRequest,
  InspectReport,
} from './types.js';
