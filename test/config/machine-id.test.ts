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

  it('fallback path produces a 64-char hex string when node-machine-id throws', async () => {
    // Mock node-machine-id to throw
    vi.doMock('node-machine-id', () => {
      return {
        machineId: () => {
          throw new Error('not available');
        },
      };
    });

    // Re-import to get the module with mocked dependency
    const { getMachineId } = await import('../../src/config/machine-id.js');
    const id = await getMachineId();

    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{64}$/); // sha256 hex = 64 chars

    vi.doUnmock('node-machine-id');
  });
});
