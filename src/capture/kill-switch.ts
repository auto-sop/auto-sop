/**
 * Capture kill-switch.
 *
 * Returns `true` when Phase-2 capture should be suppressed for the current
 * process. The canonical env var is `AUTO_SOP_CAPTURE_SUPPRESS` (with
 * `CLAUDE_SOP_CAPTURE_SUPPRESS` as deprecated fallback). The legacy name
 * `CLAUDE_SOP_LEARNER` is still honored so that tick scripts installed by
 * older versions continue to suppress capture during a learner run — but
 * we emit a one-shot deprecation notice to stderr so users can migrate.
 *
 * Precedence:
 *   1. `AUTO_SOP_CAPTURE_SUPPRESS=1` → suppress (no deprecation notice)
 *   2. `CLAUDE_SOP_CAPTURE_SUPPRESS=1` → suppress + warn once (use AUTO_SOP_*)
 *   3. `CLAUDE_SOP_LEARNER=1` (and new vars unset) → suppress + warn once
 *   4. otherwise → do not suppress
 */

/** Module-scoped flag: emit the deprecation notice at most once per process. */
let deprecationWarned = false;

export function isCaptureDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.AUTO_SOP_CAPTURE_SUPPRESS === '1') return true;
  if (env.CLAUDE_SOP_CAPTURE_SUPPRESS === '1') {
    emitDeprecationNotice('CLAUDE_SOP_CAPTURE_SUPPRESS', 'AUTO_SOP_CAPTURE_SUPPRESS');
    return true;
  }
  if (env.CLAUDE_SOP_LEARNER === '1') {
    emitDeprecationNotice('CLAUDE_SOP_LEARNER', 'AUTO_SOP_CAPTURE_SUPPRESS');
    return true;
  }
  return false;
}

function emitDeprecationNotice(oldVar: string, newVar: string): void {
  if (deprecationWarned) return;
  deprecationWarned = true;
  try {
    process.stderr.write(
      `[auto-sop] ${oldVar} is deprecated; ` +
        `use ${newVar} instead.\n`,
    );
  } catch {
    /* stderr may be closed in detached writer — ignore */
  }
}

/** Test-only: reset the one-shot warn flag between tests. */
export function _resetDeprecationWarnedForTests(): void {
  deprecationWarned = false;
}
