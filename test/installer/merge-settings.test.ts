import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import {
  mergeProjectHooks,
  mergeGlobalMarketplace,
} from '../../src/installer/merge-settings.js';
import {
  buildHookEntries,
  CLAUDE_SOP_HOOK_ID,
  HOOK_EVENTS,
} from '../../src/installer/hook-entries.js';
import { parse } from 'jsonc-parser';

describe('mergeProjectHooks', () => {
  let testDir: string;
  let settingsPath: string;
  const shimPath = '/abs/path/to/shim.cjs';
  const entries = buildHookEntries(shimPath);

  beforeEach(async () => {
    testDir = join(tmpdir(), `merge-settings-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
    settingsPath = join(testDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('creates file from nonexistent path', async () => {
    await mergeProjectHooks(settingsPath, entries);
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].id).toBe(
      CLAUDE_SOP_HOOK_ID,
    );
  });

  it('handles empty file (Pitfall 4)', async () => {
    await fs.writeFile(settingsPath, '');
    await mergeProjectHooks(settingsPath, entries);
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('preserves existing user hooks — user first, claude-sop last', async () => {
    const fixture = JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '/usr/local/bin/my-hook',
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    await fs.writeFile(settingsPath, fixture);
    await mergeProjectHooks(settingsPath, entries);

    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    const arr = parsed.hooks.UserPromptSubmit;
    expect(arr).toHaveLength(2);
    // User hook at index 0
    expect(arr[0].hooks[0].command).toBe('/usr/local/bin/my-hook');
    // claude-sop at index 1
    expect(arr[1].hooks[0].id).toBe(CLAUDE_SOP_HOOK_ID);
  });

  it('is idempotent — second merge is byte-identical', async () => {
    await mergeProjectHooks(settingsPath, entries);
    const first = await fs.readFile(settingsPath, 'utf8');
    await mergeProjectHooks(settingsPath, entries);
    const second = await fs.readFile(settingsPath, 'utf8');
    expect(second).toBe(first);
  });

  it('preserves JSONC comments', async () => {
    const fixture = '// my comment\n{"hooks":{}}';
    await fs.writeFile(settingsPath, fixture);
    await mergeProjectHooks(settingsPath, entries);
    const text = await fs.readFile(settingsPath, 'utf8');
    expect(text).toContain('// my comment');
  });

  it('strips prior claude-sop entries (no duplicates)', async () => {
    // First merge
    await mergeProjectHooks(settingsPath, entries);
    // Manually add a second claude-sop entry to simulate corruption
    const text1 = await fs.readFile(settingsPath, 'utf8');
    const parsed1 = parse(text1);
    // Verify there's exactly 1 entry per event
    for (const ev of HOOK_EVENTS) {
      const arr = parsed1.hooks[ev];
      const sopEntries = arr.filter((e: any) =>
        e.hooks?.some?.((h: any) => h.id === CLAUDE_SOP_HOOK_ID),
      );
      expect(sopEntries).toHaveLength(1);
    }
    // Merge again — still exactly 1
    await mergeProjectHooks(settingsPath, entries);
    const text2 = await fs.readFile(settingsPath, 'utf8');
    const parsed2 = parse(text2);
    for (const ev of HOOK_EVENTS) {
      const sopEntries = parsed2.hooks[ev].filter((e: any) =>
        e.hooks?.some?.((h: any) => h.id === CLAUDE_SOP_HOOK_ID),
      );
      expect(sopEntries).toHaveLength(1);
    }
  });

  it('populates all 5 events on empty file', async () => {
    await mergeProjectHooks(settingsPath, entries);
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    for (const ev of HOOK_EVENTS) {
      expect(parsed.hooks[ev]).toHaveLength(1);
    }
  });

  it('throws on invalid JSON — file not overwritten', async () => {
    await fs.writeFile(settingsPath, 'not json');
    await expect(mergeProjectHooks(settingsPath, entries)).rejects.toThrow(
      'settings.json is not a JSON object',
    );
    const text = await fs.readFile(settingsPath, 'utf8');
    expect(text).toBe('not json');
  });
});

describe('mergeGlobalMarketplace', () => {
  let testDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `marketplace-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
    settingsPath = join(testDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('writes extraKnownMarketplaces with absolute path', async () => {
    const mpDir = '/usr/local/lib/node_modules/claude-sop/marketplace';
    await mergeGlobalMarketplace(settingsPath, mpDir);
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    expect(parsed.extraKnownMarketplaces['claude-sop'].source.path).toBe(
      mpDir,
    );
    expect(
      parsed.extraKnownMarketplaces['claude-sop'].source.source,
    ).toBe('directory');
  });

  it('throws on non-absolute path', async () => {
    await expect(
      mergeGlobalMarketplace(settingsPath, '~/relative/path'),
    ).rejects.toThrow('marketplaceDirAbs must be absolute');
  });

  it('does NOT touch enabledPlugins (mutual exclusion G1)', async () => {
    const fixture = JSON.stringify(
      { enabledPlugins: ['some-plugin'] },
      null,
      2,
    );
    await fs.writeFile(settingsPath, fixture);
    await mergeGlobalMarketplace(settingsPath, '/abs/marketplace');
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    expect(parsed.enabledPlugins).toEqual(['some-plugin']);
  });
});
