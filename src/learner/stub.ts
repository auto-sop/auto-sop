/**
 * Learner stub — fail-open tick logger.
 * Appends a single line to ~/.claude-sop/logs/ticks.log and exits 0.
 * Real learner logic will replace this in Phase 3.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Pause check: if paused.flag exists in the project's .claude-sop dir, exit silently.
// Fail-open: if the check itself errors, continue normally.
try {
  const pausedFlag = join(process.cwd(), '.claude-sop', 'paused.flag');
  if (existsSync(pausedFlag)) {
    process.exit(0);
  }
} catch {
  // fail-open: ignore errors and continue
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
