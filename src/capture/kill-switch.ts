/**
 * Capture kill-switch.
 *
 * Returns `true` when Phase-2 capture should be suppressed for the current
 * process. The canonical env var is `CLAUDE_SOP_CAPTURE_SUPPRESS`. The
 * legacy name `CLAUDE_SOP_LEARNER` is still honored so that tick scripts
 * installed by older versions continue to suppress capture during a
 * learner run — but we emit a one-shot deprecation notice to stderr so
 * users and operators can migrate.
 *
 * Precedence:
 *   1. `CLAUDE_SOP_CAPTURE_SUPPRESS=1` → suppress (no deprecation notice)
 *   2. `CLAUDE_SOP_LEARNER=1` (and new var unset) → suppress + warn once
 *   3. otherwise → do not suppress
 */

/** Module-scoped flag: emit the deprecation notice at most once per process. */
let deprecationWarned = false;

export function isCaptureDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLAUDE_SOP_CAPTURE_SUPPRESS === '1') return true;
  if (env.CLAUDE_SOP_LEARNER === '1') {
    emitDeprecationNotice();
    return true;
  }
  return false;
}

function emitDeprecationNotice(): void {
  if (deprecationWarned) return;
  deprecationWarned = true;
  try {
    process.stderr.write(
      '[claude-sop] CLAUDE_SOP_LEARNER is deprecated; ' +
        'use CLAUDE_SOP_CAPTURE_SUPPRESS instead.\n',
    );
  } catch {
    /* stderr may be closed in detached writer — ignore */
  }
}

/** Test-only: reset the one-shot warn flag between tests. */
export function _resetDeprecationWarnedForTests(): void {
  deprecationWarned = false;
}
