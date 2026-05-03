export interface SchedulerInstallOpts {
  tickScriptPath: string; // absolute path to tick.sh or tick.cmd
  intervalSec: number; // 3600 default
  logDir: string; // absolute path to ~/.auto-sop/logs
  homeDir: string; // absolute path to $HOME / %USERPROFILE%
  user: string; // process.env.USER or USERNAME
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
