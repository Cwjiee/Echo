export type ActionName = 'git_status' | 'git_fetch' | 'git_pull' | 'npm_install' | 'run_tests';

export interface ExecutionResult {
  action: ActionName;
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ApprovedResolutionPayload {
  action_id: string;
  actions: ActionName[];
  context: {
    repository?: string;
    branch?: string;
    workdir?: string;
  };
}
