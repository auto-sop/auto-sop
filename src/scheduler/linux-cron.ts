import { execa } from 'execa';
import type {
  SchedulerBackend,
  SchedulerInstallOpts,
  SchedulerStatus,
} from './types.js';

const MARKER = '# claude-sop:managed';

export const linuxCron: SchedulerBackend = {
  name: 'cron',

  async install(opts: SchedulerInstallOpts): Promise<void> {
    const existing =
      (await execa('crontab', ['-l'], { reject: false })).stdout || '';
    const stripped = existing
      .split('\n')
      .filter((l) => !l.includes(MARKER))
      .join('\n');
    const entry = `0 * * * * ${opts.tickScriptPath} ${MARKER}`;
    const next =
      (stripped.trimEnd() + '\n' + entry + '\n').replace(/\n\n+/g, '\n');
    await execa('crontab', ['-'], { input: next });
  },

  async uninstall(opts: {
    homeDir: string;
    user: string;
  }): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const r = await execa('crontab', ['-l'], { reject: false });
    if (r.exitCode !== 0) {
      // No crontab — nothing to uninstall
      return { warnings };
    }
    const stripped = (r.stdout || '')
      .split('\n')
      .filter((l) => !l.includes(MARKER))
      .join('\n');
    const next = stripped.trimEnd() + '\n';
    await execa('crontab', ['-'], { input: next });
    return { warnings };
  },

  async status(_opts: {
    homeDir: string;
    user: string;
  }): Promise<SchedulerStatus> {
    const r = await execa('crontab', ['-l'], { reject: false });
    const installed = (r.stdout || '').includes(MARKER);
    return {
      backend: 'cron',
      installed,
      lastTickAt: null,
      lastExitCode: null,
      details: { note: 'cron backend; last-tick unknown from cron' },
    };
  },
};
