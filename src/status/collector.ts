import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse } from 'jsonc-parser';
import { HOOK_EVENTS, CLAUDE_SOP_HOOK_ID, LEGACY_HOOK_ID } from '../installer/hook-entries.js';
import { readInstalledVersion } from '../installer/version.js';
import { MANAGED_BEGIN, MANAGED_END } from '../installer/managed-section.js';
import { readSecrets } from '../license/storage.js';
import { trialStatus } from '../license/trial.js';
import type { SchedulerBackend, SchedulerStatus } from '../scheduler/types.js';

export interface StatusReport {
  project: { root: string; hash12: string; slug: string };
  installedVersion: string | null;
  hooks: {
    wiringState: 'present' | 'absent' | 'stale';
    eventsCovered: string[];
    settingsPath: string;
  };
  scheduler: SchedulerStatus;
  learner: { lastRunAt: number | null; lastExitCode: number | null };
  pendingCaptures: number;
  directives: { count: number; sectionPresent: boolean };
  license: {
    status: 'dev-key' | 'trial' | 'expired' | 'user' | 'none';
    daysRemaining: number | null;
  };
  errors: { last24h: number };
  disk: { usageBytes: number; capBytes: number | null };
  paused: boolean;
}

export interface CollectOptions {
  projectRoot: string;
  homeDir: string;
  projectHash12: string;
  projectSlug: string;
  schedulerBackend?: SchedulerBackend | undefined;
}

export async function collectStatus(opts: CollectOptions): Promise<StatusReport> {
  const claudeSopHome = path.join(opts.homeDir, '.auto-sop');
  const versionTxt = path.join(claudeSopHome, 'version.txt');
  const secretsEnc = path.join(claudeSopHome, 'secrets.enc');
  const projectClaudeSettings = path.join(opts.projectRoot, '.claude', 'settings.json');
  const claudeMdPath = path.join(opts.projectRoot, 'CLAUDE.md');
  const capturesDir = path.join(opts.projectRoot, '.auto-sop', 'captures');
  const errorsJsonl = path.join(opts.projectRoot, '.auto-sop', 'errors.jsonl');
  const pausedFlag = path.join(opts.projectRoot, '.auto-sop', 'paused.flag');

  const installedVersion = await readInstalledVersion(versionTxt);
  const hooks = await inspectHooks(projectClaudeSettings);
  let scheduler: SchedulerStatus = opts.schedulerBackend
    ? await opts.schedulerBackend.status({
        homeDir: opts.homeDir,
        user: process.env.USER ?? process.env.USERNAME ?? '',
      })
    : {
        backend: 'none',
        installed: false,
        lastTickAt: null,
        lastExitCode: null,
        details: {},
      };

  // BUG-C1: If scheduler doesn't report lastTickAt, read from recap log
  if (scheduler.lastTickAt === null) {
    const recapLastTickAt = await readLastTickFromRecap(claudeSopHome);
    if (recapLastTickAt !== null) {
      scheduler = { ...scheduler, lastTickAt: recapLastTickAt };
    }
  }
  const learner = await readLastLearnerRun(opts.projectRoot);
  const pendingCaptures = await countPendingCaptures(capturesDir, learner.lastRunAt);
  const directives = await countDirectives(claudeMdPath, opts.projectRoot);
  const license = await readLicenseStatus(secretsEnc);
  const errors = { last24h: await count24hErrors(errorsJsonl) };
  const disk = await diskUsage(capturesDir);
  const paused = await pathExists(pausedFlag);

  return {
    project: {
      root: opts.projectRoot,
      hash12: opts.projectHash12,
      slug: opts.projectSlug,
    },
    installedVersion,
    hooks,
    scheduler,
    learner,
    pendingCaptures,
    directives,
    license,
    errors,
    disk,
    paused,
  };
}

async function inspectHooks(settingsPath: string): Promise<StatusReport['hooks']> {
  let text: string;
  try {
    text = await fs.readFile(settingsPath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { wiringState: 'absent', eventsCovered: [], settingsPath };
    throw e;
  }
  const parsed = parse(text, [], { allowTrailingComma: true });
  const eventsCovered: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const arr: unknown[] = parsed?.hooks?.[ev] ?? [];
    const hasOurs = arr.some(
      (e: unknown) =>
        ((e as Record<string, unknown>)?.hooks as unknown[] | undefined)?.some(
          (h: unknown) =>
            (h as Record<string, unknown>)?.id === CLAUDE_SOP_HOOK_ID ||
            (h as Record<string, unknown>)?.id === LEGACY_HOOK_ID,
        ) ?? false,
    );
    if (hasOurs) eventsCovered.push(ev);
  }
  if (eventsCovered.length === HOOK_EVENTS.length)
    return { wiringState: 'present', eventsCovered, settingsPath };
  if (eventsCovered.length === 0) return { wiringState: 'absent', eventsCovered, settingsPath };
  return { wiringState: 'stale', eventsCovered, settingsPath };
}

async function readLastLearnerRun(
  projectRoot: string,
): Promise<{ lastRunAt: number | null; lastExitCode: number | null }> {
  const cursorPath = path.join(projectRoot, '.auto-sop', 'state', 'learner-cursor.json');
  try {
    const raw = await fs.readFile(cursorPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.updated_at === 'string' && parsed.updated_at.length > 0) {
      const ms = Date.parse(parsed.updated_at);
      if (Number.isFinite(ms)) {
        return { lastRunAt: ms, lastExitCode: null };
      }
    }
    return { lastRunAt: null, lastExitCode: null };
  } catch {
    // File missing or parse error → null (backward compat)
    return { lastRunAt: null, lastExitCode: null };
  }
}

async function countPendingCaptures(
  capturesDir: string,
  lastRunAt: number | null,
): Promise<number> {
  try {
    const entries = await fs.readdir(capturesDir);
    if (lastRunAt == null) return entries.length;
    const stats = await Promise.all(entries.map((e) => fs.stat(path.join(capturesDir, e))));
    return stats.filter((s) => s.mtimeMs > lastRunAt).length;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

async function countDirectives(
  claudeMdPath: string,
  projectRoot: string,
): Promise<{ count: number; sectionPresent: boolean }> {
  // BUG-C1: Try directive history first (authoritative source)
  const historyPath = path.join(projectRoot, '.auto-sop', 'state', 'directive-history.json');
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: Record<string, { pruned?: boolean }> };
    if (parsed.entries && typeof parsed.entries === 'object') {
      const activeCount = Object.values(parsed.entries).filter((e) => e.pruned !== true).length;
      // Check if managed section exists in CLAUDE.md for sectionPresent flag
      let sectionPresent = false;
      try {
        const text = await fs.readFile(claudeMdPath, 'utf8');
        sectionPresent = text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
      } catch {
        // CLAUDE.md missing → section not present
      }
      return { count: activeCount, sectionPresent };
    }
  } catch {
    // History file missing/corrupt → fall through to CLAUDE.md fallback
  }

  // Fallback: count directives from CLAUDE.md managed section
  try {
    const text = await fs.readFile(claudeMdPath, 'utf8');
    const begin = text.indexOf(MANAGED_BEGIN);
    const end = text.indexOf(MANAGED_END);
    if (begin === -1 || end === -1) return { count: 0, sectionPresent: false };
    const between = text.slice(begin + MANAGED_BEGIN.length, end);
    const count = (between.match(/^- /gm) || []).length;
    return { count, sectionPresent: true };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, sectionPresent: false };
    throw e;
  }
}

async function readLicenseStatus(secretsEnc: string): Promise<StatusReport['license']> {
  try {
    const payload = await readSecrets(secretsEnc);
    if (payload == null) return { status: 'none', daysRemaining: null };
    const t = trialStatus(payload);
    return {
      status: t.status === 'user' ? 'user' : t.status,
      daysRemaining: Number.isFinite(t.daysRemaining)
        ? Math.round(t.daysRemaining * 10) / 10
        : null,
    };
  } catch {
    return { status: 'none', daysRemaining: null };
  }
}

async function count24hErrors(errorsJsonl: string): Promise<number> {
  try {
    const text = await fs.readFile(errorsJsonl, 'utf8');
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.ts === 'number' && obj.ts >= cutoff) n++;
      } catch {
        /* skip malformed lines */
      }
    }
    return n;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

async function diskUsage(dir: string): Promise<StatusReport['disk']> {
  try {
    const usage = await walkSum(dir);
    return { usageBytes: usage, capBytes: null };
  } catch {
    /* ENOENT etc. */
    return { usageBytes: 0, capBytes: null };
  }
}

async function walkSum(p: string): Promise<number> {
  const st = await fs.stat(p);
  if (!st.isDirectory()) return st.size;
  const entries = await fs.readdir(p);
  const sizes = await Promise.all(entries.map((e) => walkSum(path.join(p, e)).catch(() => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * BUG-C1: Read the last recap log line and parse its `t` field for the
 * most recent tick timestamp. Returns epoch ms or null.
 */
async function readLastTickFromRecap(claudeSopHome: string): Promise<number | null> {
  const recapPath = path.join(claudeSopHome, 'logs', 'recap.log');
  try {
    const text = await fs.readFile(recapPath, 'utf8');
    const lines = text.trimEnd().split('\n');
    // Walk backward to find the last parseable line with a `t` field
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.t === 'string' && obj.t.length > 0) {
          const ms = Date.parse(obj.t);
          if (Number.isFinite(ms)) return ms;
        }
      } catch {
        // malformed line — try previous
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
