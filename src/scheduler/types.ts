export interface SchedulerInstallOpts {
  tickScriptPath: string; // absolute path to tick.sh or tick.cmd
  intervalSec: number; // 86400 (daily)
  logDir: string; // absolute path to ~/.auto-sop/logs
  homeDir: string; // absolute path to $HOME / %USERPROFILE%
  user: string; // process.env.USER or USERNAME
  /** Hour (0-23) for daily scheduling. Derived from install time for distribution. */
  dailyHour?: number | undefined;
  /** Minute (0-59) for daily scheduling. Derived from install time for distribution. */
  dailyMinute?: number | undefined;
}

export interface SchedulerStatus {
  backend: 'launchd' | 'systemd' | 'cron' | 'task-scheduler' | 'none';
  installed: boolean;
  lastTickAt: number | null; // epoch ms, or null if never
  lastExitCode: number | null;
  details: Record<string, unknown>;
}

export interface SchedulerBackend {
  readonly name: 'launchd' | 'systemd' | 'cron' | 'task-scheduler';
  install(opts: SchedulerInstallOpts): Promise<void>;
  uninstall(opts: { homeDir: string; user: string }): Promise<{ warnings: string[] }>;
  status(opts: { homeDir: string; user: string }): Promise<SchedulerStatus>;
}
