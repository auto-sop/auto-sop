/**
 * Learner stub — fail-open tick logger.
 * Appends a single line to ~/.claude-sop/logs/ticks.log and exits 0.
 * Real learner logic will replace this in Phase 3.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isCaptureDisabled } from '../capture/kill-switch.js';

// Kill-switch: if capture is disabled, exit immediately before any I/O
if (isCaptureDisabled(process.env)) {
  process.exit(0);
}

const VERSION = '0.0.0';

try {
  const logDir = join(homedir(), '.claude-sop', 'logs');
  mkdirSync(logDir, { recursive: true });
  const line = `${new Date().toISOString()} learner-stub v${VERSION} pid=${process.pid}\n`;
  appendFileSync(join(logDir, 'ticks.log'), line);
} catch {
  // fail-open: swallow all errors
}

process.exit(0);
