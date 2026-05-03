/**
 * Project Registry — tracks installed projects at ~/.auto-sop/projects.json.
 * Reads are unlocked (tolerate ENOENT + parse errors).
 * Writes use proper-lockfile for mutual exclusion.
 * Fail-open: all errors are logged and swallowed.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { lockSync, unlockSync } from 'proper-lockfile';
import { appendFileSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────

export interface ProjectRegistryEntry {
  project_id: string;
  slug: string;
  project_root: string;
  installed_at: string; // ISO8601
  last_seen_at: string; // ISO8601
}

export interface ProjectRegistry {
  version: 1;
  projects: ProjectRegistryEntry[];
}

// ── Paths ──────────────────────────────────────────────────

export function registryPath(home?: string): string {
  return join(home ?? homedir(), '.auto-sop', 'projects.json');
}

function lockfilePath(home?: string): string {
  return join(home ?? homedir(), '.auto-sop', 'projects.json.lock');
}

function errorsLogPath(home?: string): string {
  return join(home ?? homedir(), '.auto-sop', 'logs', 'errors.log');
}

// ── Error logger (inline, fail-safe) ───────────────────────

function logRegistryError(kind: string, err: unknown, home?: string): void {
  try {
    const logPath = errorsLogPath(home);
    mkdirSync(dirname(logPath), { recursive: true });
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        kind,
        err: err instanceof Error ? err.message : String(err),
      }) + '\n';
    appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
    // Error logging must never itself throw
  }
}

// ── Path validation ───────────────────────────────────────

/**
 * Validates a project root path is absolute and contains no traversal segments.
 * Returns the resolved (normalized) path.
 * Throws on invalid input — callers must catch accordingly.
 */
export function validateProjectRoot(projectRoot: string): string {
  // Check absolute BEFORE resolve — resolve() would make it absolute
  if (!isAbsolute(projectRoot)) {
    throw new Error(`project_root is not absolute: ${projectRoot}`);
  }
  // Check for traversal in raw input before resolving
  if (projectRoot.includes('..')) {
    throw new Error(`project_root contains traversal segments: ${projectRoot}`);
  }
  const resolved = resolve(projectRoot);
  return resolved;
}

// ── Read (unlocked) ────────────────────────────────────────

export function readRegistry(home?: string): ProjectRegistry {
  const empty: ProjectRegistry = { version: 1, projects: [] };
  try {
    const raw = readFileSync(registryPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || !Array.isArray(parsed?.projects)) {
      logRegistryError('registry_invalid_schema', 'missing version or projects array', home);
      return empty;
    }
    return parsed as ProjectRegistry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    logRegistryError('registry_read_failed', err, home);
    return empty;
  }
}

// ── Write (locked, atomic) ─────────────────────────────────

function writeRegistry(registry: ProjectRegistry, home?: string): void {
  const regPath = registryPath(home);
  const lockPath = lockfilePath(home);
  mkdirSync(dirname(regPath), { recursive: true });

  // Ensure lockfile target exists (proper-lockfile needs it)
  if (!existsSync(regPath)) {
    writeFileSync(regPath, '{}', { mode: 0o600 });
  }

  try {
    lockSync(regPath, {
      lockfilePath: lockPath,
      stale: 5000,
    });
  } catch (err) {
    logRegistryError('registry_lock_failed', err, home);
    throw err; // caller will catch
  }

  try {
    const tmpPath = regPath + '.tmp';
    const content = JSON.stringify(registry, null, 2) + '\n';
    writeFileSync(tmpPath, content, { mode: 0o600 });
    // fsync via opening + closing is not available synchronously in a simple way;
    // rename provides atomicity guarantee on POSIX
    renameSync(tmpPath, regPath);
  } finally {
    try {
      unlockSync(regPath, { lockfilePath: lockPath });
      // released
    } catch {
      // best-effort release
    }
  }
}

// ── Upsert (add or update) ─────────────────────────────────

export function upsertProject(
  projectId: string,
  slug: string,
  projectRoot: string,
  home?: string,
): void {
  // Validate at write time — reject bad values before they enter the registry
  const validRoot = validateProjectRoot(projectRoot);

  const registry = readRegistry(home);
  const now = new Date().toISOString();
  const idx = registry.projects.findIndex((p) => p.project_id === projectId);
  if (idx >= 0) {
    registry.projects[idx]!.slug = slug;
    registry.projects[idx]!.project_root = validRoot;
    registry.projects[idx]!.last_seen_at = now;
  } else {
    registry.projects.push({
      project_id: projectId,
      slug,
      project_root: validRoot,
      installed_at: now,
      last_seen_at: now,
    });
  }
  writeRegistry(registry, home);
}

// ── Remove ─────────────────────────────────────────────────

export function removeProject(projectId: string, home?: string): void {
  const registry = readRegistry(home);
  registry.projects = registry.projects.filter((p) => p.project_id !== projectId);
  writeRegistry(registry, home);
}
