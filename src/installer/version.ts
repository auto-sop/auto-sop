import { promises as fs } from 'node:fs';
import semver from 'semver';
import { writeFileAtomic } from '../atomic/write.js';

export type Verdict = 'none' | 'same' | 'newer-package' | 'older-package';

/**
 * Read the installed version from a version.txt file.
 * Returns null if file does not exist or contains invalid semver.
 */
export async function readInstalledVersion(versionTxtPath: string): Promise<string | null> {
  try {
    const raw = (await fs.readFile(versionTxtPath, 'utf8')).trim();
    return semver.valid(raw);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Write a semver version string to version.txt atomically.
 */
export async function writeInstalledVersion(
  versionTxtPath: string,
  version: string,
): Promise<void> {
  if (!semver.valid(version)) throw new Error(`invalid semver: ${version}`);
  await writeFileAtomic(versionTxtPath, version + '\n');
}

/**
 * Compare installed version against current package version.
 * Returns a human-readable verdict.
 */
export function compareVersions(installed: string | null, current: string): Verdict {
  if (installed == null) return 'none';
  const cmp = semver.compare(installed, current);
  if (cmp === 0) return 'same';
  if (cmp < 0) return 'newer-package';
  return 'older-package';
}
