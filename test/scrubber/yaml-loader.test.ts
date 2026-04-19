import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { loadRulePack, rulePackSchema } from '../../src/scrubber/yaml-loader.js';

const TMP = join(tmpdir(), 'auto-sop-yaml-loader-test');

beforeAll(async () => {
  installNoNetworkGuards();
  await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  restoreNetworkGuards();
  await rm(TMP, { recursive: true, force: true });
});

async function writeYaml(name: string, content: string): Promise<string> {
  const p = join(TMP, name);
  await writeFile(p, content, 'utf8');
  return p;
}

describe('loadRulePack', () => {
  it('parses a valid YAML rule pack', async () => {
    const path = await writeYaml(
      'valid.yaml',
      `
version: 1
rules:
  - id: aws-key
    description: AWS access key
    pattern: "AKIA[0-9A-Z]{16}"
`,
    );
    const pack = await loadRulePack(path);
    expect(pack.version).toBe(1);
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0]!.id).toBe('aws-key');
  });

  it('allows empty rules array', async () => {
    const path = await writeYaml(
      'empty-rules.yaml',
      `
version: 1
rules: []
`,
    );
    const pack = await loadRulePack(path);
    expect(pack.rules).toHaveLength(0);
  });

  it('rejects unknown top-level key (strict)', async () => {
    const path = await writeYaml(
      'extra-top.yaml',
      `
version: 1
rules: []
author: someone
`,
    );
    await expect(loadRulePack(path)).rejects.toThrow();
  });

  it('rejects unknown key inside a rule (inner strict)', async () => {
    const path = await writeYaml(
      'extra-rule-key.yaml',
      `
version: 1
rules:
  - id: test
    description: test rule
    pattern: "test"
    severity: high
`,
    );
    await expect(loadRulePack(path)).rejects.toThrow();
  });

  it('throws with rule id when regex pattern is invalid', async () => {
    const path = await writeYaml(
      'bad-regex.yaml',
      `
version: 1
rules:
  - id: broken-regex
    description: intentionally broken
    pattern: "[invalid"
`,
    );
    await expect(loadRulePack(path)).rejects.toThrow(/broken-regex/);
    await expect(loadRulePack(path)).rejects.toThrow(/invalid regex/i);
  });

  it('preserves optional fields (flags, replacement)', async () => {
    const path = await writeYaml(
      'optional-fields.yaml',
      `
version: 1
rules:
  - id: env-var
    description: Env variable assignment
    pattern: "^(\\\\w+)=(.+)$"
    flags: gm
    replacement: "$1=[REDACTED]"
`,
    );
    const pack = await loadRulePack(path);
    expect(pack.rules[0]!.flags).toBe('gm');
    expect(pack.rules[0]!.replacement).toBe('$1=[REDACTED]');
  });
});

describe('rulePackSchema', () => {
  it('rejects version !== 1', () => {
    const result = rulePackSchema.safeParse({ version: 2, rules: [] });
    expect(result.success).toBe(false);
  });

  it('rejects rule with empty id', () => {
    const result = rulePackSchema.safeParse({
      version: 1,
      rules: [{ id: '', description: 'x', pattern: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});
