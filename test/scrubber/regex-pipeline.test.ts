import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { applyRegexPipeline } from '../../src/scrubber/regex-pipeline.js';
import { formatRedaction } from '../../src/scrubber/redaction.js';
import { parse } from 'yaml';
import { BASELINE_YAML } from '../../src/scrubber/baseline.generated.js';
import { rulePackSchema } from '../../src/scrubber/yaml-loader.js';
import type { Rule } from '../../src/scrubber/types.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

function loadBaselineRules(): Rule[] {
  const doc: unknown = parse(BASELINE_YAML);
  return rulePackSchema.parse(doc).rules;
}

describe('applyRegexPipeline', () => {
  const rules = loadBaselineRules();

  it('redacts anthropic-api-key (sk-ant-*)', () => {
    const secret = 'sk-ant-abcdefghij1234567890XYZ';
    const input = `key: ${secret}`;
    const { output, replaced } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
    expect(output).toContain(`key: ${formatRedaction(secret)}`);
    expect(replaced).toBeGreaterThanOrEqual(1);
  });

  it('redacts aws-access-key-id', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const input = `aws_key=${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });

  it('redacts github-token (ghp_*)', () => {
    const secret = 'ghp_abcdefghij1234567890ABCDEFGHIJ123456';
    const input = `GITHUB_TOKEN=${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });

  it('env-assignment preserves key name: API_KEY=secret → API_KEY=[REDACTED]', () => {
    const input = 'API_KEY=supersecretvalue123';
    const { output, replaced } = applyRegexPipeline(input, rules);
    expect(output).toContain('API_KEY=[REDACTED]');
    expect(output).not.toContain('supersecretvalue123');
    expect(replaced).toBeGreaterThanOrEqual(1);
  });

  it('redacts JWT (three base64url-encoded segments)', () => {
    const secret =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `Authorization: Bearer ${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });

  it('returns total replaced count across multiple rules', () => {
    const input = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghij1234567890ABCDEFGHIJ123456',
      'sk-ant-abcdefghij1234567890XYZ',
    ].join('\n');
    const { replaced } = applyRegexPipeline(input, rules);
    expect(replaced).toBeGreaterThanOrEqual(3);
  });

  it('same secret produces same redaction output (deterministic)', () => {
    const secret = 'sk-ant-determinismtest1234567890';
    const input = `token: ${secret}`;
    const { output: out1 } = applyRegexPipeline(input, rules);
    const { output: out2 } = applyRegexPipeline(input, rules);
    expect(out1).toBe(out2);
  });

  it('no matches returns input unchanged with replaced=0', () => {
    const input = 'hello world this is safe text';
    const { output, replaced } = applyRegexPipeline(input, rules);
    expect(output).toBe(input);
    expect(replaced).toBe(0);
  });

  it('redacts slack-token', () => {
    const secret = 'xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx';
    const input = `SLACK_TOKEN=${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });

  it('redacts stripe-key', () => {
    const secret = 'sk_test_abcdefghijklmnopqrstuvwxyz';
    const input = `stripe: ${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });

  it('redacts gitlab-token', () => {
    const secret = 'glpat-abcdefghij1234567890';
    const input = `GITLAB_TOKEN=${secret}`;
    const { output } = applyRegexPipeline(input, rules);
    expect(output).not.toContain(secret);
  });
});
