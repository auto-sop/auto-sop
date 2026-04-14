import { promises as fs } from 'node:fs';
import { parse, modify, applyEdits, type JSONPath } from 'jsonc-parser';
import { writeFileAtomic } from '../atomic/write.js';
import {
  HOOK_EVENTS,
  CLAUDE_SOP_HOOK_ID,
  type HookEvent,
  type HookEntry,
} from './hook-entries.js';

const FORMAT_OPTIONS = { insertSpaces: true, tabSize: 2 };

/**
 * Read a settings file, returning "{}" for missing or empty files.
 */
async function readSettingsText(settingsPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    return raw === '' ? '{}' : raw;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '{}';
    throw e;
  }
}

/**
 * Validate that text parses to a JSON object (not array, null, etc).
 */
function assertJsonObject(text: string): void {
  const parsed = parse(text, [], { allowTrailingComma: true });
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object');
  }
}

/**
 * Merge project hook entries into a project's .claude/settings.json.
 * User hooks are preserved in order; claude-sop entries are appended LAST.
 * Prior claude-sop entries (detected by id) are stripped before appending.
 * Uses jsonc-parser to preserve comments and formatting.
 */
export async function mergeProjectHooks(
  settingsPath: string,
  entries: Record<HookEvent, HookEntry>,
): Promise<void> {
  let text = await readSettingsText(settingsPath);
  assertJsonObject(text);

  for (const event of HOOK_EVENTS) {
    const path: JSONPath = ['hooks', event];

    // Read existing array at this path
    const parsed = parse(text, [], { allowTrailingComma: true });
    const existingArray: HookEntry[] =
      parsed?.hooks?.[event] != null ? (parsed.hooks[event] as HookEntry[]) : [];

    // Filter out prior claude-sop entries
    const userEntries = existingArray.filter(
      (entry) =>
        !entry.hooks?.some?.((h) => h.id === CLAUDE_SOP_HOOK_ID),
    );

    // Append our entry LAST
    const merged = [...userEntries, entries[event]];

    // Apply edit
    const edits = modify(text, path, merged, {
      formattingOptions: FORMAT_OPTIONS,
    });
    text = applyEdits(text, edits);
  }

  await writeFileAtomic(settingsPath, text);
}

/**
 * Register a marketplace directory in the global ~/.claude/settings.json.
 * Uses extraKnownMarketplaces (NOT enabledPlugins — mutual exclusion G1).
 * marketplaceDirAbs must be an absolute path.
 */
export async function mergeGlobalMarketplace(
  settingsPath: string,
  marketplaceDirAbs: string,
): Promise<void> {
  if (!marketplaceDirAbs.startsWith('/')) {
    throw new Error(
      `marketplaceDirAbs must be absolute, got: ${marketplaceDirAbs}`,
    );
  }

  let text = await readSettingsText(settingsPath);
  assertJsonObject(text);

  const value = { source: { source: 'directory', path: marketplaceDirAbs } };
  const edits = modify(
    text,
    ['extraKnownMarketplaces', 'claude-sop'],
    value,
    { formattingOptions: FORMAT_OPTIONS },
  );
  text = applyEdits(text, edits);

  await writeFileAtomic(settingsPath, text);
}
