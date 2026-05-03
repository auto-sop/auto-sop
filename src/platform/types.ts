export interface PlatformAdapter {
  readonly name: 'darwin' | 'linux' | 'win32';

  /** Scheduler backend name for this platform. */
  schedulerBackendName(): string;

  /** Current OS user. Falls back across env vars per platform. */
  currentUser(): string;

  /** Set file permissions. No-op on Windows. */
  chmod(filePath: string, mode: number): Promise<void>;

  /** Set file permissions synchronously. No-op on Windows. */
  chmodSync(filePath: string, mode: number): void;

  /** File extension for the tick wrapper script. */
  tickScriptExtension(): string;

  /** Restrict file access to owner only. Uses chmod on POSIX, icacls on Windows. */
  restrictFileAccess(filePath: string): Promise<void>;
}
