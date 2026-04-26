import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import {
  createBindingToken,
  createBindingFile,
  readBindingFile,
  verifyBindingToken,
  writeBindingFile,
} from '../../src/license/binding.js';

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

const LICENSE_KEY = 'test-license-key-abc123';
const PROJECT_PATH = '/home/user/projects/my-app';
const MACHINE_ID = 'deadbeefdeadbeefdeadbeefdeadbeef';

describe('createBindingToken', () => {
  it('returns a hex string', () => {
    const token = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  it('is deterministic', () => {
    const a = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    const b = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    expect(a).toBe(b);
  });

  it('differs with different license key', () => {
    const a = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    const b = createBindingToken('different-key', PROJECT_PATH, MACHINE_ID);
    expect(a).not.toBe(b);
  });

  it('differs with different project path', () => {
    const a = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    const b = createBindingToken(LICENSE_KEY, '/other/path', MACHINE_ID);
    expect(a).not.toBe(b);
  });

  it('differs with different machine id', () => {
    const a = createBindingToken(LICENSE_KEY, PROJECT_PATH, MACHINE_ID);
    const b = createBindingToken(LICENSE_KEY, PROJECT_PATH, 'other-machine-id');
    expect(a).not.toBe(b);
  });
});

describe('createBindingFile', () => {
  it('returns BindingFile with all fields', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(bf.license_key_hash).toHaveLength(16);
    expect(bf.license_key_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(bf.machine_id).toBe(MACHINE_ID);
    expect(bf.bound_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(bf.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('license_key_hash does not reveal the full key', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(bf.license_key_hash).not.toContain(LICENSE_KEY);
    expect(JSON.stringify(bf)).not.toContain(LICENSE_KEY);
  });
});

describe('verifyBindingToken', () => {
  it('verifies a correctly created binding', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(verifyBindingToken(bf, LICENSE_KEY, PROJECT_PATH, MACHINE_ID)).toBe(true);
  });

  it('fails when project path differs (file copied to different project)', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(verifyBindingToken(bf, LICENSE_KEY, '/other/project', MACHINE_ID)).toBe(false);
  });

  it('fails when license key differs', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(verifyBindingToken(bf, 'wrong-key', PROJECT_PATH, MACHINE_ID)).toBe(false);
  });

  it('fails when machine id differs', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    expect(verifyBindingToken(bf, LICENSE_KEY, PROJECT_PATH, 'different-machine')).toBe(false);
  });

  it('fails when token is tampered', () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    const tampered = { ...bf, token: bf.token.replace(/^./, 'f') };
    expect(verifyBindingToken(tampered, LICENSE_KEY, PROJECT_PATH, MACHINE_ID)).toBe(false);
  });
});

describe('writeBindingFile / readBindingFile', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `binding-test-${nanoid(10)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('round-trips a binding file', async () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    await writeBindingFile(testDir, bf);
    const read = await readBindingFile(testDir);
    expect(read).toEqual(bf);
  });

  it('returns null for missing file', async () => {
    const result = await readBindingFile(join(testDir, 'nonexistent'));
    expect(result).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    await fs.writeFile(join(testDir, 'binding.json'), '{bad json}}}');
    const result = await readBindingFile(testDir);
    expect(result).toBeNull();
  });

  it('returns null for JSON missing required fields', async () => {
    await fs.writeFile(join(testDir, 'binding.json'), '{"foo": "bar"}');
    const result = await readBindingFile(testDir);
    expect(result).toBeNull();
  });

  it('file has mode 0o600', async () => {
    const bf = createBindingFile({
      licenseKey: LICENSE_KEY,
      projectPath: PROJECT_PATH,
      machineId: MACHINE_ID,
    });
    await writeBindingFile(testDir, bf);
    const stat = await fs.stat(join(testDir, 'binding.json'));
    // On non-Windows systems, check permissions
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
