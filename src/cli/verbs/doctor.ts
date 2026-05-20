import type { Command } from 'commander';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import { execa } from 'execa';
import { collectStatus } from '../../status/collector.js';
import { PathResolver } from '../../path-resolver/index.js';
import { pickBackend } from '../../scheduler/index.js';
import { TASK_NAME } from '../../scheduler/windows-task-scheduler.js';
import { emit } from '../output/json.js';
import { renderTable } from '../output/human.js';
import { PreconditionError } from '../errors.js';
import {
  STALE_MARKER_MAX_AGE_MS,
  SYNC_QUEUE_MAX_ENTRIES,
  BINDING_FILE,
  TURN_MARKER_PREFIX,
  TURN_MARKER_SUFFIX,
} from '../../capture/writer/state-hygiene.js';
import { readSyncEntries } from '../../learner/sync-queue.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function registerDoctorVerb(program: Command): void {
  program
    .command('doctor')
    .description('run install health checks')
    .option('--project <path>', 'project root', process.cwd())
    .action(async (opts, cmd) => {
      const jsonMode = cmd.parent?.opts().json ?? false;
      const projectRoot = path.resolve(opts.project as string);
      const homeDir = os.homedir();

      const resolver = new PathResolver();
      const { identity } = await resolver.resolve(projectRoot);

      let schedulerBackend;
      try {
        const picked = await pickBackend();
        schedulerBackend = picked.backend;
      } catch {
        /* unsupported platform */
      }

      const report = await collectStatus({
        projectRoot,
        homeDir,
        projectHash12: identity.projectId,
        projectSlug: identity.slug,
        schedulerBackend,
      });

      const checks: Check[] = [
        {
          name: 'installed',
          ok: report.installedVersion !== null,
          detail: report.installedVersion ?? 'version.txt missing',
        },
        {
          name: 'hooks wired',
          ok: report.hooks.wiringState === 'present',
          detail: `${report.hooks.eventsCovered.length}/5 events`,
        },
        await schedulerEffectiveCheck(homeDir),
        {
          name: 'managed section',
          ok: report.directives.count === 0 || report.directives.sectionPresent,
          detail:
            report.directives.count === 0
              ? 'no directives yet'
              : report.directives.sectionPresent
                ? `${report.directives.count} directives`
                : `${report.directives.count} directives not synced`,
        },
        {
          name: 'license configured',
          ok: report.license.status !== 'none',
          detail: report.license.status,
        },
        {
          name: 'license not expired',
          ok: report.license.status !== 'expired',
          detail: report.license.daysRemaining != null ? `${report.license.daysRemaining}d` : 'n/a',
        },
        {
          name: 'disk usage',
          ok: true,
          detail: String(report.disk.usageBytes) + ' bytes',
        },
        {
          name: 'not paused',
          ok: !report.paused,
          detail: report.paused ? 'paused.flag present' : 'active',
        },
        {
          name: 'scrubber rules loadable',
          ok: await scrubberRulesLoadable(),
          detail: 'secretlint preset',
        },
        ...runStateHygieneChecks(projectRoot),
      ];
      const failed = checks.filter((c) => !c.ok);

      if (jsonMode) {
        emit({ ok: failed.length === 0, verb: 'doctor', checks });
      } else {
        process.stdout.write(pc.bold('auto-sop doctor') + '\n');
        process.stdout.write(
          renderTable(
            checks.map((c) => [
              c.name,
              (c.ok ? pc.green('ok') : pc.red('fail')) + ' \u2014 ' + c.detail,
            ]),
          ) + '\n',
        );
      }
      if (failed.length > 0) {
        throw new PreconditionError(
          `${failed.length} check(s) failed: ${failed.map((f) => f.name).join(', ')}`,
        );
      }
    });
}

async function schedulerEffectiveCheck(homeDir: string): Promise<Check> {
  if (process.platform === 'win32') {
    return schedulerEffectiveCheckWindows();
  }
  if (process.platform !== 'darwin') {
    // Linux: fall back to simple installed check
    return {
      name: 'scheduler effective',
      ok: true,
      detail: 'non-macOS platform — skipped',
    };
  }

  const label = process.env.AUTO_SOP_LABEL?.startsWith('com.auto-sop.learner')
    ? process.env.AUTO_SOP_LABEL
    : process.env.CLAUDE_SOP_LABEL?.startsWith('com.claude-sop.learner')
      ? process.env.CLAUDE_SOP_LABEL
      : 'com.auto-sop.learner';

  const uid = process.getuid?.() ?? 501;
  const serviceTarget = `gui/${uid}/${label}`;

  // 1. launchctl print
  const result = await execa('launchctl', ['print', serviceTarget], {
    reject: false,
  });
  if (result.exitCode !== 0) {
    return {
      name: 'scheduler effective',
      ok: false,
      detail: `service not loaded (${serviceTarget})`,
    };
  }

  // 2. Parse runs and last exit code from stdout
  const runsMatch = result.stdout.match(/^\s*runs\s*=\s*(\d+)/m);
  const lastExitMatch = result.stdout.match(/^\s*last exit code\s*=\s*(.+)$/m);
  if (!runsMatch || !lastExitMatch) {
    return {
      name: 'scheduler effective',
      ok: false,
      detail: 'cannot parse launchctl print output',
    };
  }

  const runs = parseInt(runsMatch[1]!, 10);
  const lastExit = lastExitMatch[1]!.trim();

  // 3. Read install age from version.txt mtime
  const versionFile = path.join(homeDir, '.auto-sop', 'version.txt');
  let installAgeMin = Infinity;
  try {
    const stat = await fs.stat(versionFile);
    installAgeMin = Math.floor((Date.now() - stat.mtimeMs) / 60000);
  } catch {
    // If version.txt missing, treat as old install (no grace window)
  }

  // 4. Verdict logic
  if (runs === 0 && installAgeMin > 90) {
    return {
      name: 'scheduler effective',
      ok: false,
      detail: `never fired in ${installAgeMin}min (expected at least one daily fire)`,
    };
  }
  if (runs === 0 && installAgeMin <= 90) {
    return {
      name: 'scheduler effective',
      ok: true,
      detail: `fresh install (${installAgeMin}min ago); next fire at top of hour`,
    };
  }
  if (runs >= 1 && lastExit === '0') {
    return {
      name: 'scheduler effective',
      ok: true,
      detail: `runs=${runs}, last exit 0`,
    };
  }
  if (runs >= 1 && lastExit !== '0' && lastExit !== '(never exited)') {
    return {
      name: 'scheduler effective',
      ok: false,
      detail: `runs=${runs}, last exit ${lastExit}`,
    };
  }
  return {
    name: 'scheduler effective',
    ok: true,
    detail: `runs=${runs}, last exit ${lastExit}`,
  };
}

async function schedulerEffectiveCheckWindows(): Promise<Check> {
  const r = await execa('schtasks', ['/Query', '/TN', TASK_NAME], { reject: false });
  return {
    name: 'scheduler effective',
    ok: r.exitCode === 0,
    detail: r.exitCode === 0 ? 'Task Scheduler task registered' : 'Task Scheduler task not found',
  };
}

async function scrubberRulesLoadable(): Promise<boolean> {
  try {
    // Verify the scrubber module is importable (Phase 0 artifact).
    // We don't call loadRulePack() here because it requires a path to a YAML file;
    // just confirming the module resolves is sufficient for the health check.
    const mod = await import('../../scrubber/index.js');
    return typeof mod.loadRulePack === 'function';
  } catch {
    return false;
  }
}

// ── State hygiene checks ─────────────────────────────────

/** Threshold for warning about stale markers (more than 10 is suspicious). */
export const STALE_MARKER_WARN_THRESHOLD = 10;

/**
 * Run state-hygiene doctor checks synchronously.
 * Each check is best-effort — errors produce a passing check with a note.
 */
function runStateHygieneChecks(projectRoot: string): Check[] {
  const stateDir = path.join(projectRoot, '.auto-sop', 'state');
  const checks: Check[] = [];

  // 1. Stale turn markers
  checks.push(checkStaleMarkers(stateDir));

  // 2. Nested state/state directory
  checks.push(checkNestedStateDir(stateDir));

  // 3. Sync queue size
  checks.push(checkSyncQueueSize(stateDir));

  // 4. Stray .auto-sop directories
  checks.push(checkStrayAutoSopDirs(projectRoot));

  return checks;
}

function checkStaleMarkers(stateDir: string): Check {
  try {
    if (!existsSync(stateDir)) {
      return { name: 'stale turn markers', ok: true, detail: 'no state dir' };
    }
    const entries = readdirSync(stateDir);
    const now = Date.now();
    let staleCount = 0;
    for (const entry of entries) {
      if (!entry.startsWith(TURN_MARKER_PREFIX) || !entry.endsWith(TURN_MARKER_SUFFIX)) continue;
      try {
        const stat = statSync(path.join(stateDir, entry));
        if (now - stat.mtimeMs > STALE_MARKER_MAX_AGE_MS) staleCount++;
      } catch {
        // skip unreadable files
      }
    }
    if (staleCount > STALE_MARKER_WARN_THRESHOLD) {
      return {
        name: 'stale turn markers',
        ok: false,
        detail: `${staleCount} orphan markers (>24h old) — run auto-sop repair`,
      };
    }
    return {
      name: 'stale turn markers',
      ok: true,
      detail: staleCount === 0 ? 'none' : `${staleCount} (below threshold)`,
    };
  } catch {
    return { name: 'stale turn markers', ok: true, detail: 'check skipped (read error)' };
  }
}

function checkNestedStateDir(stateDir: string): Check {
  try {
    const nested = path.join(stateDir, 'state');
    if (existsSync(nested) && statSync(nested).isDirectory()) {
      return {
        name: 'nested state dir',
        ok: false,
        detail: 'state/state exists — run auto-sop repair',
      };
    }
    return { name: 'nested state dir', ok: true, detail: 'clean' };
  } catch {
    return { name: 'nested state dir', ok: true, detail: 'check skipped (read error)' };
  }
}

function checkSyncQueueSize(stateDir: string): Check {
  try {
    const entries = readSyncEntries(stateDir);
    if (entries.length > SYNC_QUEUE_MAX_ENTRIES) {
      return {
        name: 'sync queue size',
        ok: false,
        detail: `${entries.length} entries (>${SYNC_QUEUE_MAX_ENTRIES}) — run auto-sop repair --compact-sync`,
      };
    }
    return {
      name: 'sync queue size',
      ok: true,
      detail: `${entries.length} entries`,
    };
  } catch {
    return { name: 'sync queue size', ok: true, detail: 'check skipped (read error)' };
  }
}

function checkStrayAutoSopDirs(projectRoot: string): Check {
  try {
    const entries = readdirSync(projectRoot, { withFileTypes: true });
    const stray: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subdirAutoSop = path.join(projectRoot, entry.name, '.auto-sop');
      try {
        if (!existsSync(subdirAutoSop)) continue;
        if (!statSync(subdirAutoSop).isDirectory()) continue;
        if (existsSync(path.join(subdirAutoSop, BINDING_FILE))) continue;
        stray.push(entry.name);
      } catch {
        // skip unreadable subdirectories
      }
    }
    if (stray.length > 0) {
      return {
        name: 'stray .auto-sop dirs',
        ok: false,
        detail: `${stray.length} stray dir(s): ${stray.join(', ')} — run auto-sop repair --clean-stray`,
      };
    }
    return { name: 'stray .auto-sop dirs', ok: true, detail: 'none' };
  } catch {
    return { name: 'stray .auto-sop dirs', ok: true, detail: 'check skipped (read error)' };
  }
}
