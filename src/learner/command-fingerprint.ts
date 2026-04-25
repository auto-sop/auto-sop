/**
 * Shared command fingerprinting utilities — extracted from
 * repeated-bash-failure.ts so multiple modules can reuse them.
 *
 * fingerprintCommand: normalizes a Bash command string for grouping.
 * isBashFailure: determines whether a post-event ToolCall represents a failure.
 */
import type { ToolCall } from './turn-loader.js';

const FINGERPRINT_MAX_LEN = 100;

/**
 * Fingerprint a Bash command for grouping:
 * - trim
 * - collapse interior whitespace runs to single space
 * - take first 100 chars
 */
export function fingerprintCommand(command: string): string {
  const trimmed = command.trim();
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.slice(0, FINGERPRINT_MAX_LEN);
}

/**
 * Decide whether a post-event ToolCall represents a Bash failure.
 *
 * Primary signal: `success === false`. Secondary: output.exitCode is
 * a non-zero number (belt-and-suspenders in case the hook omits the
 * success flag).
 *
 * IMPORTANT: this function reads structured fields only. It does NOT
 * inspect stderr/stdout text content.
 */
export function isBashFailure(call: ToolCall): boolean {
  if (call.success === false) return true;
  if (call.output && typeof call.output === 'object') {
    const out = call.output as Record<string, unknown>;
    if (typeof out.exitCode === 'number' && out.exitCode !== 0) return true;
    // Some Claude Code tool wrappers report via `interrupted: true` on hard kill;
    // that's an environment failure, worth counting.
    if (out.interrupted === true) return true;
  }
  return false;
}
