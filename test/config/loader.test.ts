import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { vol } from 'memfs';

// Mock node:fs and node:fs/promises with memfs
vi.mock('node:fs', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs;
});
vi.mock('node:fs/promises', async () => {
  const memfs = await vi.importActual<typeof import('memfs')>('memfs');
  return memfs.fs.promises;
});

import { loadConfig, ConfigError } from '../../src/config/loader.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

beforeEach(() => {
  vol.reset();
});

describe('loadConfig', () => {
  it('returns defaults when no global file present', async () => {
    const cfg = await loadConfig({ globalPath: '/tmp/missing/config.json' });
    expect(cfg.version).toBe(1);
    expect(cfg.learner.model).toBe('claude-sonnet-4');
    expect(cfg.license).toEqual({});
  });

  it('returns parsed config from valid global file', async () => {
    vol.fromJSON({
      '/global/config.json': JSON.stringify({
        version: 1,
        learner: { model: 'claude-opus' },
      }),
    });
    const cfg = await loadConfig({ globalPath: '/global/config.json' });
    expect(cfg.learner.model).toBe('claude-opus');
    expect(cfg.learner.maxCapturesPerRun).toBe(50); // default preserved
  });

  it('throws ConfigError with "unknown keys" on invalid global', async () => {
    vol.fromJSON({
      '/global/config.json': JSON.stringify({
        version: 1,
        badKey: 'oops',
      }),
    });
    await expect(loadConfig({ globalPath: '/global/config.json' })).rejects.toThrow(ConfigError);
    try {
      await loadConfig({ globalPath: '/global/config.json' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('unknown keys');
    }
  });

  it('ConfigError.file equals the offending file path', async () => {
    vol.fromJSON({
      '/global/config.json': JSON.stringify({
        version: 1,
        badKey: 'oops',
      }),
    });
    try {
      await loadConfig({ globalPath: '/global/config.json' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).file).toBe('/global/config.json');
    }
  });

  it('merges global + project config with project wins', async () => {
    vol.fromJSON({
      '/global/config.json': JSON.stringify({
        version: 1,
        learner: { model: 'claude-sonnet-4' },
      }),
      '/project/config.json': JSON.stringify({
        learner: { model: 'claude-opus' },
      }),
    });
    const cfg = await loadConfig({
      globalPath: '/global/config.json',
      projectPath: '/project/config.json',
    });
    expect(cfg.learner.model).toBe('claude-opus');
  });

  it('fails loud on invalid project file with file path in error', async () => {
    vol.fromJSON({
      '/global/config.json': JSON.stringify({ version: 1 }),
      '/project/config.json': JSON.stringify({
        learner: { unknownField: 1 },
      }),
    });
    try {
      await loadConfig({
        globalPath: '/global/config.json',
        projectPath: '/project/config.json',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).file).toBe('/project/config.json');
      expect((err as ConfigError).message).toContain('unknown keys');
    }
  });
});
