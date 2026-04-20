import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
        const payload = JSON.stringify({
          on,
          project_slug: slug,
          project_root: projectRoot,
        });
        process.stdout.write(payload);
      } else {
        process.stdout.write(on ? '[sop:on]' : '[sop:off]');
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
 * e.g. `{"workspace":{"current_dir":"/path/to/project"}, …}`. In dev-army
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

/**
 * Check if .claude/settings.json has any hook with 'auto-sop' or 'claude-sop' in command.
 * Fail-closed: any error → false.
 *
 * Real Claude Code settings.json structure (three levels deep):
 *   { "hooks": { "<EventName>": [ { "hooks": [ { "command": "..." } ] } ] } }
 */
function detectHooks(projectRoot: string): boolean {
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
          if (
            typeof hook === 'object' &&
            hook !== null &&
            typeof (hook as Record<string, unknown>).command === 'string' &&
            (((hook as Record<string, unknown>).command as string).includes('auto-sop') ||
              ((hook as Record<string, unknown>).command as string).includes('claude-sop'))
          ) {
            return true;
          }
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
