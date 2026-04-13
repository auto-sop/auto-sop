import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configSchema, licenseSchema, scrubberSchema } from '../../src/config/schema.js';
import { createDefaultConfig } from '../../src/config/loader.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('configSchema', () => {
  it('createDefaultConfig() returns a valid ConfigV1 with version 1 and defaults', () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.learner.model).toBe('claude-sonnet-4');
    expect(cfg.learner.maxCapturesPerRun).toBe(50);
    expect(cfg.learner.timeoutSeconds).toBe(600);
    expect(cfg.scrubber.entropyThreshold).toBe(4.5);
    expect(cfg.scrubber.minTokenLen).toBe(20);
    expect(cfg.license).toEqual({});
  });

  it('rejects unknown top-level keys', () => {
    const result = configSchema.safeParse({
      version: 1,
      foo: 'bar',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect(issue!.keys).toContain('foo');
    }
  });

  it('rejects unknown nested keys in learner', () => {
    const result = configSchema.safeParse({
      version: 1,
      learner: { unknownField: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect(issue!.keys).toContain('unknownField');
    }
  });

  it('license namespace accepts all 4 optional fields and defaults to {}', () => {
    const full = licenseSchema.parse({
      keyRef: 'ref-123',
      trialStartedAt: 1700000000,
      lastValidated: 1700000001,
      offlineGraceDays: 7,
    });
    expect(full.keyRef).toBe('ref-123');
    expect(full.trialStartedAt).toBe(1700000000);
    expect(full.lastValidated).toBe(1700000001);
    expect(full.offlineGraceDays).toBe(7);

    const empty = licenseSchema.parse({});
    expect(empty).toEqual({});
  });

  it('license namespace rejects unknown keys', () => {
    const result = licenseSchema.safeParse({ foo: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect(issue!.keys).toContain('foo');
    }
  });

  it('scrubber.entropyThreshold defaults to 4.5', () => {
    const result = scrubberSchema.parse({});
    expect(result.entropyThreshold).toBe(4.5);
  });
});
