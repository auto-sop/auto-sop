import { promises as fs } from 'node:fs';
import { chmodSync as nodeChmodSync } from 'node:fs';
import type { PlatformAdapter } from './types.js';

export const darwinAdapter: PlatformAdapter = {
  name: 'darwin',

  schedulerBackendName() {
    return 'launchd';
  },

  currentUser() {
    return process.env.USER ?? 'unknown';
  },

  async chmod(filePath: string, mode: number) {
    await fs.chmod(filePath, mode);
  },

  chmodSync(filePath: string, mode: number) {
    nodeChmodSync(filePath, mode);
  },

  tickScriptExtension() {
    return '.sh';
  },
};
