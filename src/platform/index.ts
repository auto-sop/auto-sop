import type { PlatformAdapter } from './types.js';
import { darwinAdapter } from './darwin.js';
import { linuxAdapter } from './linux.js';
import { win32Adapter } from './win32.js';

export type { PlatformAdapter } from './types.js';

/**
 * Return the PlatformAdapter for the current (or overridden) platform.
 *
 * Accepts an explicit platform string so callers (and tests) can request
 * a specific adapter without mutating `process.platform`.
 */
export function getPlatform(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  switch (platform) {
    case 'darwin':
      return darwinAdapter;
    case 'linux':
      return linuxAdapter;
    case 'win32':
      return win32Adapter;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
