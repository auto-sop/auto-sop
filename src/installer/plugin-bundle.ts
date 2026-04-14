import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Copy the plugin bundle from srcDir to dstDir.
 * Destructive: removes any existing dstDir first, then copies recursively.
 * Requires Node >= 18.17 for fs.cp recursive support.
 */
export async function copyPluginBundle(
  srcDir: string,
  dstDir: string,
): Promise<void> {
  const stat = await fs.stat(srcDir).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`plugin bundle source does not exist: ${srcDir}`);
    }
    throw e;
  });
  if (!stat.isDirectory()) {
    throw new Error(`plugin bundle source is not a directory: ${srcDir}`);
  }
  // Destructive copy: wipe existing destination
  await fs.rm(dstDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dstDir), { recursive: true });
  await fs.cp(srcDir, dstDir, { recursive: true, force: true });
}
