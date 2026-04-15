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
 */
function detectHooks(projectRoot: string): boolean {
  try {
    const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;

    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val !== 'object' || val === null) continue;
      const entry = val as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
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
