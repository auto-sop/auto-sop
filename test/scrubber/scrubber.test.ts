import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { Scrubber, createScrubber, type ScrubberOptions } from '../../src/scrubber/scrubber.js';
import { BASELINE_YAML } from '../../src/scrubber/baseline.generated.js';
import { rulePackSchema } from '../../src/scrubber/yaml-loader.js';
import { formatRedaction } from '../../src/scrubber/redaction.js';
import { parse } from 'yaml';
import type { RulePack } from '../../src/scrubber/types.js';
import { vol } from 'memfs';
import { promises as mfs } from 'memfs';

// Patch fs for createScrubber tests that read user rule dirs
import * as fsModule from 'node:fs';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

function parseBaseline(): RulePack {
  const doc: unknown = parse(BASELINE_YAML);
  return rulePackSchema.parse(doc);
}

function makeScrubber(overrides?: Partial<ScrubberOptions>): Scrubber {
  return new Scrubber({
    baselinePack: parseBaseline(),
    ...overrides,
  });
}

describe('Scrubber', () => {
  it('sensitive file path short-circuits to [REDACTED: sensitive path] with pathExcluded=true', () => {
    const scrubber = makeScrubber();
    const result = scrubber.scrub({
      payload: 'DATABASE_URL=postgres://user:pass@host/db',
      filePath: '/home/user/.env.production',
    });
    expect(result.scrubbed).toBe('[REDACTED: sensitive path]');
    expect(result.pathExcluded).toBe(true);
    expect(result.redactionsApplied).toBe(1);
  });

  it('applies BOTH regex stage AND entropy stage', () => {
    const scrubber = makeScrubber();
    const knownKey = 'AKIAIOSFODNN7EXAMPLE';
    // High entropy token that won't match any regex rule
    const unknownHighEntropy = 'aB3dF7gH1jK4mN8pQ2sT5vW9xY0zA6cE';
    const input = `key: ${knownKey} secret: ${unknownHighEntropy}`;
    const result = scrubber.scrub({ payload: input });
    expect(result.scrubbed).not.toContain(knownKey);
    expect(result.scrubbed).not.toContain(unknownHighEntropy);
    expect(result.redactionsApplied).toBeGreaterThanOrEqual(2);
    expect(result.pathExcluded).toBe(false);
  });

  it('no matches returns input unchanged with redactionsApplied=0', () => {
    const scrubber = makeScrubber();
    const input = 'hello world this is safe text with no secrets';
    const result = scrubber.scrub({ payload: input });
    expect(result.scrubbed).toBe(input);
    expect(result.redactionsApplied).toBe(0);
    expect(result.pathExcluded).toBe(false);
  });

  it('user-provided rule pack added on top redacts user rules AND baseline rules', () => {
    const userPack: RulePack = {
      version: 1,
      rules: [
        {
          id: 'custom-internal-key',
          description: 'Custom internal key pattern',
          pattern: 'int_key_[a-z0-9]{10,}',
          flags: 'g',
        },
      ],
    };
    const scrubber = makeScrubber({ userPacks: [userPack] });

    const anthropicKey = 'sk-ant-abcdefghij1234567890XYZ';
    const customKey = 'int_key_abcdefghij1234567890';
    const input = `api: ${anthropicKey} internal: ${customKey}`;
    const result = scrubber.scrub({ payload: input });

    expect(result.scrubbed).not.toContain(anthropicKey);
    expect(result.scrubbed).not.toContain(customKey);
    expect(result.redactionsApplied).toBeGreaterThanOrEqual(2);
  });

  it('Anthropic key embedded in JSON payload is redacted but context preserved', () => {
    const scrubber = makeScrubber();
    const key = 'sk-ant-abcdefghij1234567890XYZ';
    const input = JSON.stringify({
      config: { apiKey: key, model: 'claude-3', temperature: 0.7 },
    });
    const result = scrubber.scrub({ payload: input });
    expect(result.scrubbed).not.toContain(key);
    expect(result.scrubbed).toContain('"model":"claude-3"');
    expect(result.scrubbed).toContain('"temperature":0.7');
    expect(result.scrubbed).toContain(formatRedaction(key));
  });

  it('env-assignment preserves key names in scrub output', () => {
    const scrubber = makeScrubber();
    const input = 'DATABASE_URL=postgres://user:pass@host/db';
    const result = scrubber.scrub({ payload: input });
    expect(result.scrubbed).toContain('DATABASE_URL=[REDACTED]');
    expect(result.scrubbed).not.toContain('postgres://');
  });

  it('same secret produces same [REDACTED:sha4] deterministically', () => {
    const scrubber = makeScrubber();
    const key = 'sk-ant-determinismtest1234567890';
    const r1 = scrubber.scrub({ payload: `token: ${key}` });
    const r2 = scrubber.scrub({ payload: `token: ${key}` });
    expect(r1.scrubbed).toBe(r2.scrubbed);
  });
});

describe('createScrubber', () => {
  it('works with no opts (baseline-only) — proves BASELINE_YAML is importable as module constant', async () => {
    const scrubber = await createScrubber();
    const key = 'sk-ant-abcdefghij1234567890XYZ';
    const result = scrubber.scrub({ payload: `key: ${key}` });
    expect(result.scrubbed).not.toContain(key);
    expect(result.redactionsApplied).toBeGreaterThanOrEqual(1);
  });

  it('missing userRulesDir does NOT throw', async () => {
    const scrubber = await createScrubber({
      userRulesDir: '/nonexistent/path/to/rules',
    });
    expect(scrubber).toBeInstanceOf(Scrubber);
  });

  it('loads user rules from directory and merges with baseline (alphabetical order)', async () => {
    // Set up memfs with user rules
    vol.reset();
    vol.fromJSON({
      '/tmp/test-rules/aaa-custom.yaml': `version: 1
rules:
  - id: custom-a
    description: "Custom rule A"
    pattern: 'custom_a_[a-z0-9]{10,}'
    flags: 'g'
`,
      '/tmp/test-rules/bbb-custom.yaml': `version: 1
rules:
  - id: custom-b
    description: "Custom rule B"
    pattern: 'custom_b_[a-z0-9]{10,}'
    flags: 'g'
`,
    });

    // Monkey-patch fs.promises.readdir and fs.promises.readFile for the user rules dir
    const origReaddir = fsModule.promises.readdir;
    const origReadFile = fsModule.promises.readFile;

    fsModule.promises.readdir = (async (p: string, ...args: unknown[]) => {
      if (typeof p === 'string' && p.startsWith('/tmp/test-rules')) {
        return mfs.readdir(p, ...(args as [])) as ReturnType<typeof origReaddir>;
      }
      return origReaddir(p, ...(args as []));
    }) as typeof origReaddir;

    fsModule.promises.readFile = (async (p: string | Buffer, ...args: unknown[]) => {
      if (typeof p === 'string' && p.startsWith('/tmp/test-rules')) {
        return mfs.readFile(p, ...(args as [])) as ReturnType<typeof origReadFile>;
      }
      return origReadFile(p, ...(args as []));
    }) as typeof origReadFile;

    try {
      const scrubber = await createScrubber({ userRulesDir: '/tmp/test-rules' });
      // User rules should work alongside baseline
      const key = 'sk-ant-abcdefghij1234567890XYZ';
      const customA = 'custom_a_abcdefghij1234567890';
      const customB = 'custom_b_abcdefghij1234567890';
      const input = `${key} ${customA} ${customB}`;
      const result = scrubber.scrub({ payload: input });
      expect(result.scrubbed).not.toContain(key);
      expect(result.scrubbed).not.toContain(customA);
      expect(result.scrubbed).not.toContain(customB);
    } finally {
      fsModule.promises.readdir = origReaddir;
      fsModule.promises.readFile = origReadFile;
      vol.reset();
    }
  });
});
