import { execa } from 'execa';
import type { SchedulerBackend, SchedulerInstallOpts, SchedulerStatus } from './types.js';

export const TASK_NAME = 'auto-sop-learner';

export const windowsTaskScheduler: SchedulerBackend = {
  name: 'task-scheduler',

  async install(opts: SchedulerInstallOpts): Promise<void> {
    // schtasks /Create with /F (force-overwrite if exists)
    // /SC HOURLY runs every hour. /TR is the command to execute.
    // Task Scheduler handles .cmd natively; no need for node.exe or cmd.exe wrapper.
    const tr = `"${opts.tickScriptPath}"`;
    await execa('schtasks', ['/Create', '/TN', TASK_NAME, '/SC', 'HOURLY', '/TR', tr, '/F']);
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
