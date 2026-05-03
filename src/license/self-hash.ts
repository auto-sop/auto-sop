import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Separator between path and content in the hash input. */
const SEPARATOR = '\0';

/** Cached hash — computed once per process. */
let cachedHash: string | null = null;

/**
 * Resolve the dist/ directory path from the CLI entry point.
 * Handles both npm global install and local symlink cases by
 * resolving the real path of the current module.
 */
export function resolveDistDir(): string {
  // In ESM, use import.meta.url; in CJS, use __dirname.
  // At build time this compiles to CJS, so __dirname is available.
  // For safety, try both strategies.
  try {
    // ESM path
    const currentFile = fileURLToPath(import.meta.url);
    return dirname(realpathSync(currentFile));
  } catch {
    // CJS fallback — __dirname points to dist/
    return realpathSync(__dirname);
  }
}

/**
 * List all .js and .cjs files in a directory, sorted by relative path.
 * Non-recursive — only top-level files in distDir.
 */
export function listDistFiles(distDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(distDir);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.js') || f.endsWith('.cjs')).sort();
}

/**
 * Compute a deterministic SHA-256 hash of the CLI's dist/ directory.
 *
 * Algorithm:
 *   1. List all .js and .cjs files in distDir, sorted by relative path
 *   2. For each file: read content
 *   3. Concatenate: relativePath + NUL + content for each file
 *   4. SHA-256 the concatenated result
 *
 * @param distDir - Override the dist directory (for testing). When
 *   omitted, resolves from the CLI entry point.
 */
export function computeCliHash(distDir?: string): string {
  // Return cached hash if available and no explicit distDir override
  if (distDir === undefined && cachedHash !== null) return cachedHash;

  const dir = distDir ?? resolveDistDir();
  const files = listDistFiles(dir);

  const hash = createHash('sha256');
  for (const file of files) {
    const relPath = relative(dir, join(dir, file));
    const content = readFileSync(join(dir, file), 'utf8');
    hash.update(relPath + SEPARATOR + content);
  }

  const result = hash.digest('hex');

  // Only cache when using the default dist dir
  if (distDir === undefined) {
    cachedHash = result;
  }

  return result;
}

/** Reset the cached hash (for testing). */
export function resetHashCache(): void {
  cachedHash = null;
}
