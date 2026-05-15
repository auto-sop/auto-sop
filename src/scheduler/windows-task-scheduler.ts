import { execa } from 'execa';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SchedulerBackend, SchedulerInstallOpts, SchedulerStatus } from './types.js';

export const TASK_NAME = 'auto-sop-learner';

/** Escape a string for safe interpolation into XML text content. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build an XML task definition for Windows Task Scheduler.
 * XML format gives us control over power management settings
 * that are not available via schtasks /Create command-line flags.
 */
export function buildTaskXml(opts: SchedulerInstallOpts): string {
  const user = xmlEscape(opts.user || process.env.USERNAME || process.env.USER || 'SYSTEM');
  const command = xmlEscape(opts.tickScriptPath);
  const hour = opts.dailyHour ?? 0;
  const minute = opts.dailyMinute ?? 0;
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers>',
    '    <TimeTrigger>',
    '      <Repetition>',
    '        <Interval>PT24H</Interval>',
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${dateStr}T${timeStr}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${command}</Command>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\r\n');
}

export const windowsTaskScheduler: SchedulerBackend = {
  name: 'task-scheduler',

  async install(opts: SchedulerInstallOpts): Promise<void> {
    // V73: Use XML-based task definition for power management control.
    // DisallowStartIfOnBatteries=false ensures the task runs on laptops.
    const xmlContent = buildTaskXml(opts);
    const xmlPath = path.join(opts.logDir, 'auto-sop-task.xml');

    // Ensure log directory exists for temp XML file
    await fs.mkdir(opts.logDir, { recursive: true });
    await fs.writeFile(xmlPath, xmlContent, 'utf8');

    try {
      await execa('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F']);
    } finally {
      // Clean up temp XML file regardless of success/failure
      await fs.unlink(xmlPath).catch(() => {});
    }
  },

  async uninstall(): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const r = await execa('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { reject: false });
    if (r.exitCode !== 0 && r.stderr) {
      warnings.push(r.stderr);
    }
    return { warnings };
  },

  async status(_opts: { homeDir: string; user: string }): Promise<SchedulerStatus> {
    // Query in CSV verbose format for parsing
    const r = await execa('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V'], {
      reject: false,
    });

    if (r.exitCode !== 0) {
      return {
        backend: 'task-scheduler',
        installed: false,
        lastTickAt: null,
        lastExitCode: null,
        details: {},
      };
    }

    // Parse CSV output: first line is headers, second line is values
    const lines = r.stdout.trim().split('\n');
    const details: Record<string, unknown> = { raw: r.stdout };
    let lastTickAt: number | null = null;
    let lastExitCode: number | null = null;

    if (lines.length >= 2) {
      const headers = parseCsvLine(lines[0]!);
      const values = parseCsvLine(lines[1]!);

      const idx = (name: string) => headers.indexOf(name);

      const lastRunIdx = idx('Last Run Time');
      if (lastRunIdx >= 0 && values[lastRunIdx]) {
        const v = values[lastRunIdx]!;
        if (v !== 'N/A' && v !== '11/30/1999 12:00:00 AM') {
          const ms = Date.parse(v);
          if (!isNaN(ms)) lastTickAt = ms;
        }
      }

      const lastResultIdx = idx('Last Result');
      if (lastResultIdx >= 0 && values[lastResultIdx]) {
        const code = parseInt(values[lastResultIdx]!, 10);
        if (!isNaN(code)) lastExitCode = code;
      }
    }

    return {
      backend: 'task-scheduler',
      installed: true,
      lastTickAt,
      lastExitCode,
      details,
    };
  },
};

/**
 * RFC-4180 compliant CSV line parser.
 * Handles commas inside quoted fields and escaped double-quotes ("").
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    if (line[i] === '"') {
      // Quoted field: collect until closing quote
      let value = '';
      i++; // skip opening quote
      while (i < len) {
        if (line[i] === '"') {
          if (i + 1 < len && line[i + 1] === '"') {
            // Escaped quote ""
            value += '"';
            i += 2;
          } else {
            // Closing quote
            i++; // skip closing quote
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      // Skip comma after field (or end of line)
      if (i < len && line[i] === ',') {
        i++;
        // Trailing comma means there's an empty field after it
        if (i === len) fields.push('');
      }
    } else {
      // Unquoted field
      const commaIdx = line.indexOf(',', i);
      if (commaIdx === -1) {
        fields.push(line.slice(i).trim());
        break;
      } else {
        fields.push(line.slice(i, commaIdx).trim());
        i = commaIdx + 1;
        // Trailing comma means there's an empty field after it
        if (i === len) fields.push('');
      }
    }
  }

  return fields;
}
