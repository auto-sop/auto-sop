import type { PlatformAdapter } from './types.js';

export const win32Adapter: PlatformAdapter = {
  name: 'win32',

  schedulerBackendName() {
    return 'task-scheduler';
  },

  currentUser() {
    return process.env.USERNAME ?? process.env.USER ?? 'unknown';
  },

  async chmod(_filePath: string, _mode: number) {
    // Windows does not support POSIX file modes — no-op.
  },

  chmodSync(_filePath: string, _mode: number) {
    // Windows does not support POSIX file modes — no-op.
  },

  tickScriptExtension() {
    return '.cmd';
  },
};
