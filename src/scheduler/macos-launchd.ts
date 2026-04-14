import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic/write.js';
import type {
  SchedulerBackend,
  SchedulerInstallOpts,
  SchedulerStatus,
} from './types.js';

const LABEL = 'com.claude-sop.learner';

function getPosixUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('macOS launchd requires POSIX uid');
  }
  return process.getuid();
}

function plistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderPlist(opts: {
  label: string;
  tickScriptPath: string;
  intervalSec: number;
  stdoutLog: string;
  stderrLog: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(opts.tickScriptPath)}</string>
  </array>

  <key>StartInterval</key>
  <integer>${opts.intervalSec}</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutLog)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrLog)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>CLAUDE_SOP_LEARNER</key>
    <string>1</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export const macosLaunchd: SchedulerBackend = {
  name: 'launchd',

  async install(opts: SchedulerInstallOpts): Promise<void> {
    const plist = plistPath(opts.homeDir);
    const content = renderPlist({
      label: LABEL,
      tickScriptPath: opts.tickScriptPath,
      intervalSec: opts.intervalSec,
      stdoutLog: join(opts.logDir, 'launchd.out.log'),
      stderrLog: join(opts.logDir, 'launchd.err.log'),
    });

    await writeFileAtomic(plist, content);

    const uid = getPosixUid();
    // Best-effort pre-remove for idempotent re-install
    await execa('launchctl', ['bootout', `gui/${uid}/${LABEL}`], {
      reject: false,
    });
    await execa('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    await execa('launchctl', ['enable', `gui/${uid}/${LABEL}`]);
  },

  async uninstall(opts: {
    homeDir: string;
    user: string;
  }): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const uid = getPosixUid();
    const r = await execa(
      'launchctl',
      ['bootout', `gui/${uid}/${LABEL}`],
      { reject: false },
    );
    if (r.exitCode !== 0 && r.stderr) {
      warnings.push(r.stderr);
    }
    await fs.rm(plistPath(opts.homeDir), { force: true });
    return { warnings };
  },

  async status(opts: {
    homeDir: string;
    user: string;
  }): Promise<SchedulerStatus> {
    const plist = plistPath(opts.homeDir);
    let installed = false;
    try {
      await fs.access(plist);
      installed = true;
    } catch {
      // not installed
    }

    let lastExitCode: number | null = null;
    let raw = '';
    const uid = getPosixUid();
    const r = await execa(
      'launchctl',
      ['print', `gui/${uid}/${LABEL}`],
      { reject: false },
    );
    if (r.exitCode === 0) {
      raw = r.stdout;
      const m = /last exit code\s*=\s*(\d+)/i.exec(raw);
      if (m) {
        lastExitCode = parseInt(m[1]!, 10);
      }
    }

    return {
      backend: 'launchd',
      installed,
      lastTickAt: null,
      lastExitCode,
      details: { launchctlPrint: raw },
    };
  },
};
