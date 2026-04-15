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
    .option('--project <path>', 'project root', process.cwd())
    .action((opts, cmd) => {
      const projectRoot = path.resolve(opts.project as string);
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
 * Check if .claude/settings.json has any hook with 'claude-sop' in command.
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
        for (const hook of (entry as Record<string, unknown>)
          .hooks as unknown[]) {
          if (
            typeof hook === 'object' &&
            hook !== null &&
            typeof (hook as Record<string, unknown>).command === 'string' &&
            ((hook as Record<string, unknown>).command as string).includes(
              'claude-sop',
            )
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
