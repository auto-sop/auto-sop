#!/usr/bin/env node
// Cross-platform postbuild: copy plugin bundle and set executable bits (POSIX only).
import { cpSync, chmodSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';

mkdirSync('dist/plugin', { recursive: true });
cpSync('plugin/', 'dist/plugin/', { recursive: true });
cpSync('dist/capture/writer.cjs', 'dist/plugin/writer.cjs');

if (platform() !== 'win32') {
  for (const f of [
    'dist/plugin/shim.cjs',
    'dist/plugin/learner.cjs',
    'dist/capture/shim.cjs',
  ]) {
    try {
      chmodSync(f, 0o755);
    } catch {
      // File may not exist in all builds — best effort.
    }
  }
}
