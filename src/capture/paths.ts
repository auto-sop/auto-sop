import { join, sep } from 'node:path';
import { homedir } from 'node:os';

export interface CapturePaths {
  projectCaptureDir: string;
  projectStateDir: string;
  projectErrorsLog: string;
  projectPausedFlag: string;
  projectPendingCapture: string;
  tmpPayloadDir: string;
  globalSopHome: string;
  globalProjectDir: string;
  globalIndexJsonl: string;
  globalErrorsLog: string;
  agentGlobalDir: (agent: string) => string;
}

/**
 * Build all capture-layer paths for a project.
 *
 * @param projectRoot - Absolute path to the project root
 * @param projectId - 12-char hex project hash from Phase 0 PathResolver
 */
export function getCapturePaths(projectRoot: string, projectId: string): CapturePaths {
  const home = homedir();
  const claudeSopDir = join(projectRoot, '.auto-sop');
  const captureDir = join(claudeSopDir, 'captures');
  const globalSopHome = join(home, '.claude', 'sop');
  const globalProjectDir = join(globalSopHome, projectId);

  return {
    projectCaptureDir: captureDir,
    projectStateDir: join(claudeSopDir, 'state'),
    projectErrorsLog: join(claudeSopDir, 'errors.jsonl'),
    projectPausedFlag: join(claudeSopDir, 'paused.flag'),
    projectPendingCapture: join(captureDir, 'pending-capture'),
    tmpPayloadDir: join(home, '.auto-sop', 'tmp'),
    globalSopHome,
    globalProjectDir,
    globalIndexJsonl: join(globalProjectDir, 'index.jsonl'),
    globalErrorsLog: join(globalProjectDir, 'errors.jsonl'),
    agentGlobalDir: (agent: string) => join(globalSopHome, 'agents', agent),
  };
}

/**
 * Detect if the project is inside an agent workspace.
 * Returns the agent name (e.g. 'commander', 'architect') or null.
 */
export function detectAgent(projectRoot: string): string | null {
  const home = homedir();
  const agentWorkspacePrefix = join(home, '.claude', 'dev-army') + sep;

  if (!projectRoot.startsWith(agentWorkspacePrefix)) {
    return null;
  }

  const remainder = projectRoot.slice(agentWorkspacePrefix.length);
  const firstSegment = remainder.split(sep)[0];
  return firstSegment || null;
}
