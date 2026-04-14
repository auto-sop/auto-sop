import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../atomic/write.js';

/**
 * Ensure an entry exists in a .gitignore file.
 * Creates file if missing, appends if entry absent, or returns noop.
 */
export async function ensureGitignore(
  gitignorePath: string,
  entry: string,
): Promise<'created' | 'appended' | 'noop'> {
  let text: string;
  try {
    text = await fs.readFile(gitignorePath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFileAtomic(gitignorePath, entry + '\n');
      return 'created';
    }
    throw e;
  }

  const lines = text.split('\n').map((l) => l.trim());
  if (lines.includes(entry.trim())) return 'noop';

  const sep = text.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(gitignorePath, text + sep + entry + '\n');
  return 'appended';
}
