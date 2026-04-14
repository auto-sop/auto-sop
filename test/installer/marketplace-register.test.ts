import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { registerMarketplace } from '../../src/installer/marketplace-register.js';
import { parse } from 'jsonc-parser';

describe('registerMarketplace', () => {
  let testDir: string;
  let settingsPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mp-register-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
    settingsPath = join(testDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('delegates to mergeGlobalMarketplace correctly', async () => {
    const mpDir = '/usr/local/lib/node_modules/claude-sop/marketplace';
    await registerMarketplace({
      globalSettingsPath: settingsPath,
      marketplaceDir: mpDir,
    });
    const text = await fs.readFile(settingsPath, 'utf8');
    const parsed = parse(text);
    expect(parsed.extraKnownMarketplaces['claude-sop'].source.path).toBe(
      mpDir,
    );
  });

  it('rejects non-absolute marketplace path', async () => {
    await expect(
      registerMarketplace({
        globalSettingsPath: settingsPath,
        marketplaceDir: 'relative/path',
      }),
    ).rejects.toThrow('marketplaceDirAbs must be absolute');
  });
});
