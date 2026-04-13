/**
 * Capture git diff --name-only HEAD and write to files-changed.txt.
 * NEVER throws — failures result in an empty file and count 0.
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicWriteFile } from './atomic-io.js';

/**
 * Run `git diff --name-only HEAD` and write the output to files-changed.txt.
 * Returns the count of changed files.
 *
 * On failure (not a git repo, timeout, git missing): writes empty file, returns 0.
 */
export function writeFilesChanged(turnDir: string, projectRoot: string): { count: number } {
  let output = '';
  try {
    output = execSync('git diff --name-only HEAD', {
      cwd: projectRoot,
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Not a git repo, or git missing, or timeout — write empty file
  }

  const filePath = join(turnDir, 'files-changed.txt');
  const content = output ? output + '\n' : '';
  atomicWriteFile(filePath, content);

  const count = output ? output.split('\n').length : 0;
  return { count };
}
