import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { isSensitivePath, applyPathExclusion } from '../../src/scrubber/path-exclusion.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

describe('isSensitivePath', () => {
  it('matches .env', () => {
    expect(isSensitivePath('.env')).toBe(true);
  });

  it('matches config/.env.production', () => {
    expect(isSensitivePath('config/.env.production')).toBe(true);
  });

  it('matches private.pem', () => {
    expect(isSensitivePath('private.pem')).toBe(true);
  });

  it('matches ~/.ssh/id_rsa', () => {
    expect(isSensitivePath('~/.ssh/id_rsa')).toBe(true);
  });

  it('matches ~/.ssh/id_ed25519', () => {
    expect(isSensitivePath('~/.ssh/id_ed25519')).toBe(true);
  });

  it('matches src/secrets.ts', () => {
    expect(isSensitivePath('src/secrets.ts')).toBe(true);
  });

  it('matches credentials.json', () => {
    expect(isSensitivePath('credentials.json')).toBe(true);
  });

  it('matches server.key', () => {
    expect(isSensitivePath('server.key')).toBe(true);
  });

  it('does NOT match src/index.ts', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false);
  });

  it('does NOT match package.json', () => {
    expect(isSensitivePath('package.json')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isSensitivePath(undefined)).toBe(false);
  });
});

describe('applyPathExclusion', () => {
  it('replaces entire payload with redaction notice for sensitive path', () => {
    const result = applyPathExclusion('AWS_KEY=AKIA1234567890123456', '.env');
    expect(result.redacted).toBe(true);
    expect(result.output).toBe('[REDACTED: sensitive path]');
  });

  it('passes payload through unchanged for non-sensitive path', () => {
    const payload = 'const x = 1;';
    const result = applyPathExclusion(payload, 'src/index.ts');
    expect(result.redacted).toBe(false);
    expect(result.output).toBe(payload);
  });

  it('passes through when filePath is undefined', () => {
    const payload = 'some content';
    const result = applyPathExclusion(payload);
    expect(result.redacted).toBe(false);
    expect(result.output).toBe(payload);
  });
});
