import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';

/**
 * Atomically write content to a file using temp + fsync + rename.
 * Temp file is created in the same directory as the target to avoid EXDEV on cross-device rename.
 */
export async function writeFileAtomic(
  path: string,
  content: string | Buffer,
): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.${nanoid(10)}.tmp`);

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(tmp, content, { mode: 0o600 });

    const fh = await fs.open(tmp, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }

    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
