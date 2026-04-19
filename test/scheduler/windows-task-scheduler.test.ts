import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { windowsTaskScheduler, parseCsvLine, TASK_NAME } from '../../src/scheduler/windows-task-scheduler.js';

const mockExeca = vi.mocked(execa);

const baseOpts = {
  tickScriptPath: 'C:\\Users\\alice\\.auto-sop\\bin\\tick.cmd',
  intervalSec: 3600,
  logDir: 'C:\\Users\\alice\\.auto-sop\\logs',
  homeDir: 'C:\\Users\\alice',
  user: 'alice',
};

describe('windowsTaskScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has name "task-scheduler"', () => {
    expect(windowsTaskScheduler.name).toBe('task-scheduler');
  });

  describe('install', () => {
    it('calls schtasks /Create with correct arguments', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never);
      await windowsTaskScheduler.install(baseOpts);

      expect(mockExeca).toHaveBeenCalledWith('schtasks', [
        '/Create',
        '/TN', 'auto-sop-learner',
        '/SC', 'HOURLY',
        '/TR', expect.stringContaining('tick.cmd'),
        '/F',
      ]);
    });

    it('/TR does not contain node.exe — Task Scheduler handles .cmd natively', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never);
      await windowsTaskScheduler.install(baseOpts);

      const call = mockExeca.mock.calls[0]!;
      const trArg = call[1]![call[1]!.indexOf('/TR') + 1] as string;
      expect(trArg).not.toContain('node');
      expect(trArg).toBe(`"${baseOpts.tickScriptPath}"`);
    });
  });

  describe('uninstall', () => {
    it('calls schtasks /Delete and returns no warnings on success', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 0, stderr: '' } as never);
      const result = await windowsTaskScheduler.uninstall({ homeDir: 'C:\\Users\\alice', user: 'alice' });

      expect(mockExeca).toHaveBeenCalledWith('schtasks', [
        '/Delete',
        '/TN', 'auto-sop-learner',
        '/F',
      ], { reject: false });
      expect(result.warnings).toHaveLength(0);
    });

    it('collects warnings when schtasks fails', async () => {
      mockExeca.mockResolvedValueOnce({
        exitCode: 1,
        stderr: 'ERROR: The system cannot find the file specified.',
      } as never);
      const result = await windowsTaskScheduler.uninstall({ homeDir: 'C:\\Users\\alice', user: 'alice' });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('cannot find');
    });
  });

  describe('status', () => {
    it('returns installed=false when schtasks /Query fails', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' } as never);
      const result = await windowsTaskScheduler.status({ homeDir: 'C:\\Users\\alice', user: 'alice' });
      expect(result.installed).toBe(false);
      expect(result.backend).toBe('task-scheduler');
    });

    it('parses CSV output for installed task', async () => {
      const csvOutput = [
        '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run","Start In","Comment","Scheduled Task State","Idle Time","Power Management","Run As User","Delete Task If Not Rescheduled","Stop Task If Runs X Hours and X Mins","Schedule","Schedule Type","Start Time","Start Date","End Date","Days","Months","Repeat: Every","Repeat: Until: Time","Repeat: Until: Duration","Repeat: Stop If Still Running"',
        '"DESKTOP","\\auto-sop-learner","4/20/2026 3:00:00 PM","Ready","Interactive only","4/20/2026 2:00:00 PM","0","alice","node C:\\Users\\alice\\.auto-sop\\bin\\tick.cmd","N/A","N/A","Enabled","Disabled","","alice","Disabled","72:00:00","Scheduling data is not available in this format.","Hourly","2:00:00 PM","4/19/2026","N/A","N/A","N/A","1:00:00","None","None","Disabled"',
      ].join('\n');

      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: csvOutput,
      } as never);

      const result = await windowsTaskScheduler.status({ homeDir: 'C:\\Users\\alice', user: 'alice' });
      expect(result.installed).toBe(true);
      expect(result.backend).toBe('task-scheduler');
      expect(result.lastExitCode).toBe(0);
      expect(result.lastTickAt).toBeTypeOf('number');
      expect(result.lastTickAt).toBeGreaterThan(0);
    });

    it('handles N/A last run time', async () => {
      const csvOutput = [
        '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author"',
        '"DESKTOP","\\auto-sop-learner","4/20/2026 3:00:00 PM","Ready","Interactive only","N/A","267011","alice"',
      ].join('\n');

      mockExeca.mockResolvedValueOnce({
        exitCode: 0,
        stdout: csvOutput,
      } as never);

      const result = await windowsTaskScheduler.status({ homeDir: 'C:\\Users\\alice', user: 'alice' });
      expect(result.installed).toBe(true);
      expect(result.lastTickAt).toBeNull();
      expect(result.lastExitCode).toBe(267011);
    });
  });

  describe('TASK_NAME export', () => {
    it('exports the task name constant', () => {
      expect(TASK_NAME).toBe('auto-sop-learner');
    });
  });

  describe('parseCsvLine', () => {
    it('splits simple unquoted fields', () => {
      expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });

    it('strips surrounding quotes', () => {
      expect(parseCsvLine('"hello","world"')).toEqual(['hello', 'world']);
    });

    it('handles commas inside quoted fields', () => {
      expect(parseCsvLine('"one, two",three,"four, five, six"')).toEqual([
        'one, two',
        'three',
        'four, five, six',
      ]);
    });

    it('handles escaped double-quotes inside quoted fields', () => {
      expect(parseCsvLine('"say ""hello""",done')).toEqual([
        'say "hello"',
        'done',
      ]);
    });

    it('parses real schtasks CSV header line', () => {
      const header = '"HostName","TaskName","Last Run Time","Last Result"';
      expect(parseCsvLine(header)).toEqual([
        'HostName',
        'TaskName',
        'Last Run Time',
        'Last Result',
      ]);
    });

    it('handles empty fields', () => {
      expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
    });
  });
});
