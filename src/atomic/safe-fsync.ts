/**
 * Platform-safe fsync helper.
 *
 * On Windows, fsyncSync can fail with EPERM when the file was just written
 * with restrictive modes (0o600). Since the rename that follows provides
 * atomicity, skipping fsync on Windows is acceptable — durability is
 * best-effort.
 */
import { openSync, fsyncSync, closeSync, promises as fs } from 'node:fs';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * Open, fsync, and close a file. On Windows, EPERM from fsync is swallowed
 * because the underlying NTFS transaction model does not require explicit
 * fsync for crash-safe renames.
 */
export function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, 'r+');
  try {
    fsyncSync(fd);
  } catch (err: unknown) {
    if (!IS_WINDOWS || (err as NodeJS.ErrnoException).code !== 'EPERM') {
      throw err;
    }
    // Swallow EPERM on Windows — fsync is best-effort durability
  } finally {
    closeSync(fd);
  }
}

/**
 * Async variant of fsyncFile. Opens the file, calls fh.sync(), and closes.
 * On Windows, EPERM from sync is swallowed (best-effort durability).
 */
export async function fsyncFileAsync(filePath: string): Promise<void> {
  const fh = await fs.open(filePath, 'r+');
  try {
    await fh.sync();
  } catch (err: unknown) {
    if (!IS_WINDOWS || (err as NodeJS.ErrnoException).code !== 'EPERM') {
      throw err;
    }
  } finally {
    await fh.close();
  }
}
