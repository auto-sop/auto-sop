import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic/write.js';
import type { SchedulerBackend, SchedulerInstallOpts, SchedulerStatus } from './types.js';

const SERVICE_NAME = 'auto-sop-learner.service';
const TIMER_NAME = 'auto-sop-learner.timer';
const LEGACY_SERVICE_NAME = 'claude-sop-learner.service';
const LEGACY_TIMER_NAME = 'claude-sop-learner.timer';

function unitDir(homeDir: string): string {
  return join(homeDir, '.config', 'systemd', 'user');
}

export function renderServiceUnit(opts: {
  tickScriptPath: string;
  user: string;
  homeDir: string;
}): string {
  return `[Unit]
Description=auto-sop hourly learner
After=default.target

[Service]
Type=oneshot
Environment=AUTO_SOP_CAPTURE_SUPPRESS=1
Environment=CLAUDE_SOP_CAPTURE_SUPPRESS=1
Environment=CLAUDE_SOP_LEARNER=1
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=${opts.tickScriptPath}
StandardOutput=append:${join(opts.homeDir, '.auto-sop', 'logs', 'systemd.out.log')}
StandardError=append:${join(opts.homeDir, '.auto-sop', 'logs', 'systemd.err.log')}
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6
`;
}

export function renderTimerUnit(opts?: { intervalSec?: number }): string {
  const sec = opts?.intervalSec ?? 3600;
  return `[Unit]
Description=auto-sop hourly learner timer

[Timer]
OnBootSec=5min
OnUnitActiveSec=${sec}s
AccuracySec=1min
Persistent=true
Unit=${SERVICE_NAME}

[Install]
WantedBy=timers.target
`;
}

export const linuxSystemd: SchedulerBackend = {
  name: 'systemd',

  async install(opts: SchedulerInstallOpts): Promise<void> {
    const dir = unitDir(opts.homeDir);
    await fs.mkdir(dir, { recursive: true });

    await writeFileAtomic(
      join(dir, SERVICE_NAME),
      renderServiceUnit({
        tickScriptPath: opts.tickScriptPath,
        user: opts.user,
        homeDir: opts.homeDir,
      }),
    );
    await writeFileAtomic(
      join(dir, TIMER_NAME),
      renderTimerUnit({ intervalSec: opts.intervalSec }),
    );

    await execa('systemctl', ['--user', 'daemon-reload']);
    // Clean up legacy timer if it exists
    await execa('systemctl', ['--user', 'disable', '--now', LEGACY_TIMER_NAME], { reject: false });
    await fs.rm(join(dir, LEGACY_TIMER_NAME), { force: true });
    await fs.rm(join(dir, LEGACY_SERVICE_NAME), { force: true });

    await execa('systemctl', ['--user', 'enable', '--now', TIMER_NAME]);
    // Linger so timer runs when user is logged out; non-fatal
    await execa('loginctl', ['enable-linger', opts.user], { reject: false });
  },

  async uninstall(opts: { homeDir: string; user: string }): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const dir = unitDir(opts.homeDir);

    const r = await execa('systemctl', ['--user', 'disable', '--now', TIMER_NAME], {
      reject: false,
    });
    // Also clean up legacy timer
    await execa('systemctl', ['--user', 'disable', '--now', LEGACY_TIMER_NAME], { reject: false });
    if (r.exitCode !== 0 && r.stderr) {
      warnings.push(r.stderr);
    }

    await fs.rm(join(dir, TIMER_NAME), { force: true });
    await fs.rm(join(dir, SERVICE_NAME), { force: true });
    await fs.rm(join(dir, LEGACY_TIMER_NAME), { force: true });
    await fs.rm(join(dir, LEGACY_SERVICE_NAME), { force: true });
    await execa('systemctl', ['--user', 'daemon-reload'], { reject: false });

    return { warnings };
  },

  async status(opts: { homeDir: string; user: string }): Promise<SchedulerStatus> {
    const dir = unitDir(opts.homeDir);
    let installed = false;
    try {
      await fs.access(join(dir, TIMER_NAME));
      installed = true;
    } catch {
      // not installed
    }

    let lastTickAt: number | null = null;
    let lastExitCode: number | null = null;
    const details: Record<string, unknown> = {};

    const r = await execa(
      'systemctl',
      ['--user', 'show', TIMER_NAME, '--property=LastTriggerUSec,Result,ActiveState'],
      { reject: false },
    );
    if (r.exitCode === 0 && r.stdout) {
      details.raw = r.stdout;
      // Parse key=value lines
      for (const line of r.stdout.split('\n')) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=');
        if (key === 'LastTriggerUSec') {
          lastTickAt = parseLastTrigger(value);
        }
        if (key === 'Result') {
          details.result = value;
          if (value === 'success') lastExitCode = 0;
          else if (value && value !== 'success') lastExitCode = 1;
        }
        if (key === 'ActiveState') {
          details.activeState = value;
        }
      }
    }

    return {
      backend: 'systemd',
      installed,
      lastTickAt,
      lastExitCode,
      details,
    };
  },
};

/**
 * Parse systemd LastTriggerUSec value to epoch ms.
 * Formats: epoch microseconds (pure number) or human-readable timestamp.
 */
function parseLastTrigger(value: string | undefined): number | null {
  if (!value || value === '0' || value === 'n/a') return null;
  // Pure numeric: microseconds since epoch
  if (/^\d+$/.test(value)) {
    return Math.floor(parseInt(value, 10) / 1000);
  }
  // Human format: try Date.parse
  const ms = Date.parse(value);
  if (!isNaN(ms)) return ms;
  return null;
}
