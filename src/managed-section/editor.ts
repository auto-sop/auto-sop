/**
 * ManagedSectionEditor — hardened, idempotent, backed-up writer for
 * a marker-bounded section inside <project>/CLAUDE.md.
 *
 * Design invariants:
 * - Byte-preserves everything outside the markers
 * - Backup is written BEFORE the main file (crash safety)
 * - Atomic rename for the main file write
 * - Dry-run never touches the filesystem
 * - Idempotent: same content → verdict 'unchanged', no file write
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import {
  BEGIN_MARKER,
  GENERATED_COMMENT,
  END_MARKER,
  CLAUDE_MD_HEADER,
  buildSectionBlock,
  findMarkers,
  AmbiguousMarkersError,
  MalformedMarkersError,
} from './markers.js';

// Re-export error classes for consumers
export { AmbiguousMarkersError, MalformedMarkersError } from './markers.js';

// ─── Public types ────────────────────────────────────────

export interface ManagedSectionContent {
  /** Markdown body (without markers). */
  body: string;
}

export interface WriteResult {
  verdict: 'created' | 'updated' | 'unchanged' | 'dry_run';
  claudeMdPath: string;
  backupPath: string | null;
  bytesBefore: number;
  bytesAfter: number;
  markersPresent: 'before_write' | 'after_write';
  /** The computed new content — populated only when dryRun is true. */
  newContent?: string;
}

export interface WriteOptions {
  projectRoot: string;
  content: ManagedSectionContent;
  /** If true, compute new content but write nothing to disk. */
  dryRun?: boolean | undefined;
}

// ─── Path traversal guard ────────────────────────────────

function assertNoTraversal(projectRoot: string): void {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`projectRoot must be absolute, got: ${projectRoot}`);
  }
  // Defense in depth: reject traversal segments like /tmp/foo/../etc/passwd
  if (projectRoot.includes('..')) {
    throw new Error(`projectRoot must not contain '..': ${projectRoot}`);
  }
}

// ─── Write ───────────────────────────────────────────────

export function writeManagedSection(opts: WriteOptions): WriteResult {
  const { projectRoot, content, dryRun } = opts;
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  const tmpPath = claudeMdPath + '.tmp';
  const backupDir = join(projectRoot, '.claude-sop', 'state');
  const backupPath = join(backupDir, 'CLAUDE.md.backup');

  // 1. Read current content
  let current: string | null = null;
  try {
    current = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const bytesBefore = current !== null ? Buffer.byteLength(current, 'utf-8') : 0;

  // 2. Find existing markers (may throw AmbiguousMarkersError / MalformedMarkersError)
  const markers = current !== null ? findMarkers(current) : null;
  const markersPresent: WriteResult['markersPresent'] =
    markers !== null ? 'before_write' : 'after_write';

  // 3. Construct new content
  const sectionBlock = buildSectionBlock(content.body);
  let newContent: string;

  if (current === null) {
    // No file exists: create from scratch
    newContent = CLAUDE_MD_HEADER + '\n' + sectionBlock + '\n';
  } else if (markers === null) {
    // File exists but no markers: append section at the bottom
    newContent = current.replace(/\n*$/, '\n\n') + sectionBlock + '\n';
  } else {
    // File exists with markers: splice in new section
    const before = current.slice(0, markers.beginStart);
    const after = current.slice(markers.endAfter);
    newContent = before + sectionBlock + '\n' + after;
  }

  const bytesAfter = Buffer.byteLength(newContent, 'utf-8');

  // 4. Dry-run: return immediately, no disk writes
  if (dryRun === true) {
    return {
      verdict: 'dry_run',
      claudeMdPath,
      backupPath: null,
      bytesBefore,
      bytesAfter,
      markersPresent,
      newContent,
    };
  }

  // 5. Unchanged short-circuit
  if (newContent === current) {
    return {
      verdict: 'unchanged',
      claudeMdPath,
      backupPath: null,
      bytesBefore,
      bytesAfter,
      markersPresent,
    };
  }

  // 6. Backup (BEFORE main write — crash safety)
  let didBackup = false;
  if (current !== null) {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(backupPath, current, { mode: 0o600 });
    didBackup = true;
  }

  // 7. Atomic write: write tmp → fsync → rename
  try {
    writeFileSync(tmpPath, newContent, { mode: 0o644 });
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, claudeMdPath);
  } catch (err) {
    // Cleanup tmp if still present
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  // Ensure final permissions
  chmodSync(claudeMdPath, 0o644);

  const verdict: WriteResult['verdict'] = current === null ? 'created' : 'updated';

  return {
    verdict,
    claudeMdPath,
    backupPath: didBackup ? backupPath : null,
    bytesBefore,
    bytesAfter,
    markersPresent,
  };
}

// ─── Read ────────────────────────────────────────────────

export function readManagedSection(
  projectRoot: string,
): ManagedSectionContent | null {
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  let content: string;
  try {
    content = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const markers = findMarkers(content);
  if (markers === null) {
    return null;
  }

  // Extract body: everything between begin-marker line and end-marker line
  const afterBeginLine =
    content.indexOf('\n', markers.beginStart) + 1;

  // Skip the GENERATED comment line
  let bodyStart = afterBeginLine;
  const generatedLineEnd = content.indexOf('\n', afterBeginLine);
  const generatedLine = content.slice(afterBeginLine, generatedLineEnd);
  if (generatedLine.trim() === GENERATED_COMMENT) {
    bodyStart = generatedLineEnd + 1;
  }

  // Body ends at the end marker
  const endMarkerStart = content.indexOf(END_MARKER, markers.beginStart);
  let body = content.slice(bodyStart, endMarkerStart);

  // Strip leading/trailing blank lines from body
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');

  return { body };
}

// ─── Remove ──────────────────────────────────────────────

export function removeManagedSection(projectRoot: string): void {
  assertNoTraversal(projectRoot);

  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  let content: string;
  try {
    content = readFileSync(claudeMdPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // No file → no-op
    }
    throw err;
  }

  let markers: ReturnType<typeof findMarkers>;
  try {
    markers = findMarkers(content);
  } catch {
    return; // Malformed/ambiguous markers → no-op, don't risk data loss
  }

  if (markers === null) {
    return; // No markers → no-op
  }

  // Splice out the markers + body, including a trailing blank line if present
  let before = content.slice(0, markers.beginStart);
  const after = content.slice(markers.endAfter);

  // Remove the trailing blank line left by removal
  const newContent = (before + after).replace(/\n{3,}$/, '\n');

  // Atomic write
  const tmpPath = claudeMdPath + '.tmp';
  try {
    writeFileSync(tmpPath, newContent, { mode: 0o644 });
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, claudeMdPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
