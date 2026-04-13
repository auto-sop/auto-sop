import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CapturePaths {
  projectCaptureDir: string;
  projectStateDir: string;
  projectErrorsLog: string;
  projectPausedFlag: string;
  projectYarimKalan: string;
  tmpPayloadDir: string;
  globalSopHome: string;
  globalProjectDir: string;
  globalIndexJsonl: string;
  globalErrorsLog: string;
  devArmyGlobalDir: (agent: string) => string;
}

/**
 * Build all capture-layer paths for a project.
 *
 * @param projectRoot - Absolute path to the project root
 * @param projectId - 12-char hex project hash from Phase 0 PathResolver
 */
export function getCapturePaths(projectRoot: string, projectId: string): CapturePaths {
  const home = homedir();
  const claudeSopDir = join(projectRoot, '.claude-sop');
  const captureDir = join(claudeSopDir, 'captures');
  const globalSopHome = join(home, '.claude', 'sop');
  const globalProjectDir = join(globalSopHome, projectId);

  return {
    projectCaptureDir: captureDir,
    projectStateDir: join(claudeSopDir, 'state'),
    projectErrorsLog: join(claudeSopDir, 'errors.jsonl'),
    projectPausedFlag: join(claudeSopDir, 'paused.flag'),
    projectYarimKalan: join(captureDir, 'yarim-kalan'),
    tmpPayloadDir: join(home, '.claude-sop', 'tmp'),
    globalSopHome,
    globalProjectDir,
    globalIndexJsonl: join(globalProjectDir, 'index.jsonl'),
    globalErrorsLog: join(globalProjectDir, 'errors.jsonl'),
    devArmyGlobalDir: (agent: string) => join(globalSopHome, 'dev-army', agent),
  };
}

/**
 * Detect if the project is inside the dev-army workspace.
 * Returns the agent name (e.g. 'commander', 'architect') or null.
 */
export function detectDevArmyAgent(projectRoot: string): string | null {
  const home = homedir();
  const devArmyPrefix = join(home, '.claude', 'dev-army') + '/';

  if (!projectRoot.startsWith(devArmyPrefix)) {
    return null;
  }

  const remainder = projectRoot.slice(devArmyPrefix.length);
  const firstSegment = remainder.split('/')[0];
  return firstSegment || null;
}
