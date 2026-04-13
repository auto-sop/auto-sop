/**
 * Shared atomic write utility for turn-local files.
 * Writes to a temp file then renames, guaranteeing readers never see partial content.
 * All files created with 0600 permissions.
 */
import { writeFileSync, renameSync } from 'node:fs';

export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
