import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { fsyncFileAsync } from './safe-fsync.js';

/**
 * Atomically write content to a file using temp + fsync + rename.
 * Temp file is created in the same directory as the target to avoid EXDEV on cross-device rename.
 */
export async function writeFileAtomic(path: string, content: string | Buffer): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${nanoid(10)}.tmp`);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fsyncFileAsync(tmp);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
