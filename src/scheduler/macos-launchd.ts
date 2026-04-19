import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic/write.js';
import type {
  SchedulerBackend,
  SchedulerInstallOpts,
  SchedulerStatus,
} from './types.js';

/** Allow label override for integration tests to avoid colliding with the real install. */
const LABEL =
  process.env.AUTO_SOP_LABEL?.startsWith('com.auto-sop.learner')
    ? process.env.AUTO_SOP_LABEL
    : process.env.CLAUDE_SOP_LABEL?.startsWith('com.claude-sop.learner')
      ? process.env.CLAUDE_SOP_LABEL
      : 'com.auto-sop.learner';

/** Legacy label for cleanup during uninstall. */
const LEGACY_LABEL = 'com.claude-sop.learner';

function getPosixUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new Error('macOS launchd requires POSIX uid');
  }
  return process.getuid();
}

function plistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function legacyPlistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
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
  /** @deprecated Ignored on macOS — fires at :00 top of hour via StartCalendarInterval. */
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

  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutLog)}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrLog)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
    <key>AUTO_SOP_CAPTURE_SUPPRESS</key>
    <string>1</string>
    <key>CLAUDE_SOP_CAPTURE_SUPPRESS</key>
    <string>1</string>
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
    const uid = getPosixUid();
    const domainTarget = `gui/${uid}`;
    const serviceTarget = `${domainTarget}/${LABEL}`;

    // Step 0: Clean up legacy label if different from current
    if (LABEL !== LEGACY_LABEL) {
      const legacyTarget = `${domainTarget}/${LEGACY_LABEL}`;
      await execa('launchctl', ['bootout', legacyTarget], { reject: false });
      await fs.rm(legacyPlistPath(opts.homeDir), { force: true });
    }

    // Step 1: Bootout any prior version (idempotent — no-op if absent)
    await execa('launchctl', ['bootout', serviceTarget], { reject: false });

    // Step 2: Atomic write plist with StartCalendarInterval
    const content = renderPlist({
      label: LABEL,
      tickScriptPath: opts.tickScriptPath,
      intervalSec: opts.intervalSec,
      stdoutLog: join(opts.logDir, 'launchd.out.log'),
      stderrLog: join(opts.logDir, 'launchd.err.log'),
    });
    await writeFileAtomic(plist, content);

    // Step 3: Bootstrap the new version into the user GUI domain
    const bootstrapResult = await execa(
      'launchctl',
      ['bootstrap', domainTarget, plist],
      { reject: false },
    );
    if (bootstrapResult.exitCode !== 0) {
      // Fallback to legacy load -w for ancient macOS (pre-10.10)
      await execa('launchctl', ['load', '-w', plist], { reject: false });
    }

    // Step 4: Enable (lifts any "disabled" state from prior crash loops)
    await execa('launchctl', ['enable', serviceTarget], { reject: false });

    // Step 5: Warmup kickstart — prove the service can fire RIGHT NOW.
    // Without this, the user discovers the bug 1 hour after install (if ever).
    await execa('launchctl', ['kickstart', '-k', serviceTarget], {
      reject: false,
    });
  },

  async uninstall(opts: {
    homeDir: string;
    user: string;
  }): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const uid = getPosixUid();

    // Uninstall current label
    const r = await execa(
      'launchctl',
      ['bootout', `gui/${uid}/${LABEL}`],
      { reject: false },
    );
    if (r.exitCode !== 0 && r.stderr) {
      warnings.push(r.stderr);
    }
    await fs.rm(plistPath(opts.homeDir), { force: true });

    // Also clean up legacy label if different
    if (LABEL !== LEGACY_LABEL) {
      await execa(
        'launchctl',
        ['bootout', `gui/${uid}/${LEGACY_LABEL}`],
        { reject: false },
      );
      await fs.rm(legacyPlistPath(opts.homeDir), { force: true });
    }

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
