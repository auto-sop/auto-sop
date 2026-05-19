import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Display prefix for statusline output */
const OWL_PREFIX = '\u{1F989}'; // owl emoji

/** Branded statusline labels */
export const STATUSLINE_ON = `[${OWL_PREFIX}sop:on]`;
export const STATUSLINE_OFF = `[${OWL_PREFIX}sop:off]`;

/**
 * Synchronous statusline verb — must stay <50ms on a warm box.
 * No async, no child processes, no network, no logging.
 */
export function registerStatuslineVerb(program: Command): void {
  program
    .command('statusline')
    .description('print [sop:on] or [sop:off] for statusline integration')
    .option('--project <path>', 'project root')
    .action((opts, cmd) => {
      const projectRoot = getProjectRoot(opts as { project?: string });
      const jsonFlag = !!(cmd.parent?.opts().json as boolean);
      const on = detectHooks(projectRoot);

      if (jsonFlag) {
        const slug = deriveSlug(projectRoot);
        const display = on ? STATUSLINE_ON : STATUSLINE_OFF;
        const payload = JSON.stringify({
          on,
          display,
          project_slug: slug,
          project_root: projectRoot,
        });
        process.stdout.write(payload);
      } else {
        process.stdout.write(on ? STATUSLINE_ON : STATUSLINE_OFF);
      }
    });
}

/**
 * Resolve the project root in precedence order:
 *   1. --project <path> flag (explicit user intent)
 *   2. Claude Code statusline stdin JSON (workspace.current_dir)
 *   3. process.cwd() fallback
 *
 * Claude Code invokes statusline commands by piping a JSON payload on stdin,
 * e.g. `{"workspace":{"current_dir":"/path/to/project"}, …}`. In agent
 * panes (and any other wrapper spawn) process.cwd() is the wrapper's dir,
 * not the target project — reading stdin is the only reliable signal.
 *
 * All errors fall through silently so the command still returns [sop:off]
 * rather than crashing.
 */
function getProjectRoot(opts: { project?: string }): string {
  if (typeof opts.project === 'string' && opts.project.length > 0) {
    return path.resolve(opts.project);
  }

  // Claude Code pipes workspace JSON on stdin for statusline commands.
  // Only read when stdin is not a TTY — otherwise we'd block on a human.
  if (process.stdin.isTTY !== true) {
    try {
      const input = readFileSync('/dev/stdin', 'utf8');
      if (input.trim().length > 0) {
        const parsed: unknown = JSON.parse(input);
        if (typeof parsed === 'object' && parsed !== null && 'workspace' in parsed) {
          const ws = (parsed as { workspace?: unknown }).workspace;
          if (
            typeof ws === 'object' &&
            ws !== null &&
            'current_dir' in ws &&
            typeof (ws as { current_dir?: unknown }).current_dir === 'string'
          ) {
            const dir = (ws as { current_dir: string }).current_dir;
            if (dir.length > 0) return path.resolve(dir);
          }
        }
      }
    } catch {
      /* fall through to cwd */
    }
  }

  return process.cwd();
}

/** Hook identifier used by auto-sop */
const HOOK_ID = 'auto-sop';

/** Substrings that identify an auto-sop hook in command or args fields */
const HOOK_COMMAND_MARKERS = ['auto-sop', 'claude-sop'] as const;

/**
 * Check whether a single hook object matches auto-sop.
 * Returns true if ANY of the following signals match:
 *   - hook.id === 'auto-sop' (simplest and most reliable)
 *   - hook.command contains 'auto-sop' or 'claude-sop' (legacy)
 *   - any element in hook.args contains 'auto-sop' or 'claude-sop'
 */
function isAutoSopHook(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false;
  const h = hook as Record<string, unknown>;

  // Signal 1: hook.id
  if (typeof h.id === 'string' && h.id === HOOK_ID) return true;

  // Signal 2: hook.command substring match
  if (typeof h.command === 'string') {
    for (const marker of HOOK_COMMAND_MARKERS) {
      if (h.command.includes(marker)) return true;
    }
  }

  // Signal 3: hook.args array — any element containing a marker
  if (Array.isArray(h.args)) {
    for (const arg of h.args) {
      if (typeof arg !== 'string') continue;
      for (const marker of HOOK_COMMAND_MARKERS) {
        if (arg.includes(marker)) return true;
      }
    }
  }

  return false;
}

/**
 * Check if .claude/settings.json has any hook matching auto-sop.
 * Fail-closed: any error → false.
 *
 * Real Claude Code settings.json structure (three levels deep):
 *   { "hooks": { "<EventName>": [ { "hooks": [ { "command": "...", "args": [...], "id": "..." } ] } ] } }
 */
export function detectHooks(projectRoot: string): boolean {
  try {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;

    // Level 1: top-level "hooks" key
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (typeof hooks !== 'object' || hooks === null) return false;

    // Level 2: iterate event names (UserPromptSubmit, Stop, PreToolUse, …)
    for (const eventName of Object.keys(hooks as Record<string, unknown>)) {
      const entries = (hooks as Record<string, unknown>)[eventName];
      if (!Array.isArray(entries)) continue;

      // Level 3: each entry has its own nested "hooks" array
      for (const entry of entries) {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !Array.isArray((entry as Record<string, unknown>).hooks)
        )
          continue;
        for (const hook of (entry as Record<string, unknown>).hooks as unknown[]) {
          if (isAutoSopHook(hook)) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Derive a simple slug from the project root directory name.
 * Does NOT expose any settings.json contents.
 */
function deriveSlug(projectRoot: string): string | null {
  try {
    return path.basename(projectRoot) || null;
  } catch {
    return null;
  }
}
