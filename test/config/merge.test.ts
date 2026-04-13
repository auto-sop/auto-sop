import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mergeConfigs } from '../../src/config/merge.js';
import { createDefaultConfig } from '../../src/config/loader.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('mergeConfigs', () => {
  it('returns global unchanged when override is null', () => {
    const global = createDefaultConfig();
    const result = mergeConfigs(global, null);
    expect(result).toBe(global);
  });

  it('project override of learner.model wins', () => {
    const global = createDefaultConfig();
    const result = mergeConfigs(global, { learner: { model: 'claude-opus' } });
    expect(result.learner.model).toBe('claude-opus');
  });

  it('project override of one field does not wipe other fields', () => {
    const global = createDefaultConfig();
    const result = mergeConfigs(global, {
      learner: { model: 'claude-opus' },
    });
    expect(result.learner.maxCapturesPerRun).toBe(50);
    expect(result.learner.timeoutSeconds).toBe(600);
    expect(result.scrubber.entropyThreshold).toBe(4.5);
  });

  it('license override merges into global.license', () => {
    const global = createDefaultConfig();
    const result = mergeConfigs(global, {
      license: { trialStartedAt: 1700000000 },
    });
    expect(result.license.trialStartedAt).toBe(1700000000);
  });
});
