import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { writeFileAtomic } from '../atomic/write.js';
import {
  stripManagedSection,
  MANAGED_BEGIN,
  MANAGED_END,
} from './managed-section.js';
import { HOOK_EVENTS, CLAUDE_SOP_HOOK_ID } from './hook-entries.js';
import type { SchedulerBackend } from '../scheduler/types.js';
import { removeProject } from '../learner/project-registry.js';

export interface UninstallOptions {
  projectRoot: string;
  homeDir: string;
  purge: boolean;
  projectHash12: string;
  schedulerBackend?: SchedulerBackend;
  now?: number;
}

export interface UninstallResult {
  warnings: string[];
  steps: Array<{
    step: string;
    outcome: 'ok' | 'skipped' | 'warning';
    detail?: string;
  }>;
  backupPath: string | null;
}

export async function runUninstall(
  opts: UninstallOptions,
): Promise<UninstallResult> {
  const steps: UninstallResult['steps'] = [];
  const warnings: string[] = [];
  let backupPath: string | null = null;
  const now = opts.now ?? Date.now();

  const claudeSopHome = path.join(opts.homeDir, '.claude-sop');
  const tickScriptPath = path.join(claudeSopHome, 'bin', 'tick.sh');
  const secretsEncPath = path.join(claudeSopHome, 'secrets.enc');
  const versionTxtPath = path.join(claudeSopHome, 'version.txt');
  const marketplaceDir = path.join(claudeSopHome, 'marketplace', 'claude-sop');
  const projectClaudeSettings = path.join(
    opts.projectRoot,
    '.claude',
    'settings.json',
  );
  const claudeMdPath = path.join(opts.projectRoot, 'CLAUDE.md');
  const globalSopDir = path.join(
    opts.homeDir,
    '.claude',
    'sop',
    opts.projectHash12,
  );
  const managedHistoryDir = path.join(globalSopDir, 'managed-history');
  const projectCapturesDir = path.join(
    opts.projectRoot,
    '.claude-sop',
    'captures',
  );

  async function step(
    name: string,
    fn: () => Promise<string | void>,
  ): Promise<void> {
    try {
      const detail = await fn();
      const entry: UninstallResult['steps'][number] = { step: name, outcome: 'ok' };
      if (detail != null) entry.detail = detail;
      steps.push(entry);
    } catch (e: unknown) {
      const msg = `${name}: ${(e as Error)?.message ?? String(e)}`;
      warnings.push(msg);
      steps.push({ step: name, outcome: 'warning', detail: msg });
    }
  }

  // Step 1: Backup managed-section content from CLAUDE.md
  await step('backup-managed-section', async () => {
    const { removed } = await stripManagedSectionPreview(claudeMdPath);
    if (removed != null && removed.trim().length > 0) {
      await fs.mkdir(managedHistoryDir, { recursive: true });
      backupPath = path.join(managedHistoryDir, `uninstall-${now}.md`);
      await writeFileAtomic(backupPath, removed);
      return `backed up to ${backupPath}`;
    }
    return 'nothing to back up';
  });

  // Step 2: Strip managed section from CLAUDE.md
  await step('strip-managed-section', async () => {
    const { removed } = await stripManagedSection(claudeMdPath);
    return removed == null ? 'no markers found' : 'markers removed';
  });

  // Step 3: Strip claude-sop hooks from project settings.json
  await step('strip-project-hooks', async () => {
    let text: string;
    try {
      text = await fs.readFile(projectClaudeSettings, 'utf8');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return 'settings.json absent';
      throw e;
    }

    const initial = parse(text, [], { allowTrailingComma: true });
    if (!initial?.hooks) return 'no hooks key';

    let updated = text;
    for (const ev of HOOK_EVENTS) {
      // Re-parse after each mutation so the tree matches `updated`
      const current = parse(updated, [], { allowTrailingComma: true });
      const arr: unknown[] = current?.hooks?.[ev] ?? [];
      const filtered = arr.filter(
        (entry: unknown) =>
          !(
            (entry as { hooks?: Array<{ id?: string }> })?.hooks ?? []
          ).some((h) => h?.id === CLAUDE_SOP_HOOK_ID),
      );
      updated = applyEdits(
        updated,
        modify(
          updated,
          ['hooks', ev],
          filtered.length > 0 ? filtered : undefined,
          { formattingOptions: { insertSpaces: true, tabSize: 2 } },
        ),
      );
    }
    await writeFileAtomic(projectClaudeSettings, updated);
    return 'stripped';
  });

  // Step 4: Scheduler uninstall (best-effort, stub-injectable)
  await step('scheduler-uninstall', async () => {
    const backend =
      opts.schedulerBackend ??
      (await (await import('../scheduler/index.js')).pickBackend()).backend;
    const r = await backend.uninstall({
      homeDir: opts.homeDir,
      user: process.env.USER ?? '',
    });
    for (const w of r.warnings) warnings.push(`scheduler: ${w}`);
    return `backend=${backend.name}`;
  });

  // Step 5: Remove tick.sh
  await step('remove-tick-script', async () => {
    await fs.rm(tickScriptPath, { force: true });
  });

  // Step 6: Remove secrets.enc
  await step('remove-secrets', async () => {
    await fs.rm(secretsEncPath, { force: true });
  });

  // Step 7: Remove version.txt
  await step('remove-version', async () => {
    await fs.rm(versionTxtPath, { force: true });
  });

  // Step 8: Remove marketplace bundle
  await step('remove-marketplace-bundle', async () => {
    await fs.rm(marketplaceDir, { recursive: true, force: true });
  });

  // Step 9 (conditional): --purge wipes captures
  if (opts.purge) {
    await step('purge-project-captures', async () => {
      await fs.rm(projectCapturesDir, { recursive: true, force: true });
    });
    await step('purge-global-sop-dir', async () => {
      await fs.rm(globalSopDir, { recursive: true, force: true });
    });
  }

  // Step 10: Deregister project from learner registry (fail-open)
  await step('deregister-project', async () => {
    try {
      removeProject(opts.projectHash12, opts.homeDir);
      return 'removed';
    } catch {
      return 'skipped (non-critical)';
    }
  });

  return { warnings, steps, backupPath };
}

/**
 * Preview helper: reads managed section content without mutating the file.
 * Used by backup step BEFORE strip step runs.
 */
async function stripManagedSectionPreview(
  p: string,
): Promise<{ removed: string | null }> {
  try {
    const text = await fs.readFile(p, 'utf8');
    const begin = text.indexOf(MANAGED_BEGIN);
    const end = text.indexOf(MANAGED_END);
    if (begin === -1 || end === -1 || end < begin) return { removed: null };
    return { removed: text.slice(begin + MANAGED_BEGIN.length, end) };
  } catch {
    return { removed: null };
  }
}
