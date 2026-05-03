import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('getMachineId', () => {
  it('returns a non-empty string', async () => {
    const { getMachineId } = await import('../../src/config/machine-id.js');
    const id = await getMachineId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('two consecutive calls return the same value (deterministic)', async () => {
    const { getMachineId } = await import('../../src/config/machine-id.js');
    const id1 = await getMachineId();
    const id2 = await getMachineId();
    expect(id1).toBe(id2);
  });

  it('fallback path produces a 64-char hex string when platform ID fails', async () => {
    // Clear module cache so getMachineId starts fresh (no cachedId)
    vi.resetModules();

    // Mock execSync to throw (covers macOS ioreg + win32 reg query)
    vi.doMock('node:child_process', () => ({
      execSync: () => {
        throw new Error('not available');
      },
    }));

    // Mock readFileSync for /etc/machine-id (covers Linux path)
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('not available');
      },
      existsSync: () => false,
    }));

    const { getMachineId } = await import('../../src/config/machine-id.js');
    const id = await getMachineId();

    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{64}$/); // sha256 hex = 64 chars

    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
  });
});
