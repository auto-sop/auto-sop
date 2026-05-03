/**
 * Project binding — ties a license key to a specific project + machine.
 * Uses HMAC-SHA256 to create tamper-resistant binding tokens.
 * No external dependencies — Node.js crypto only.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic/write.js';

export interface BindingFile {
  /** First 16 hex chars of sha256(licenseKey) — identifies the key without storing it */
  license_key_hash: string;
  /** sha256(hostname + username) — identifies the machine */
  machine_id: string;
  /** ISO 8601 timestamp when binding was created */
  bound_at: string;
  /** HMAC-SHA256(licenseKey, projectPath + '|' + machineId) */
  token: string;
}

/**
 * Create an HMAC-SHA256 binding token.
 * The license key is the HMAC secret; the message is projectPath|machineId.
 */
export function createBindingToken(
  licenseKey: string,
  projectPath: string,
  machineId: string,
): string {
  return createHmac('sha256', licenseKey).update(`${projectPath}|${machineId}`).digest('hex');
}

export interface CreateBindingOpts {
  licenseKey: string;
  projectPath: string;
  machineId: string;
}

/**
 * Build a BindingFile object (does not write to disk).
 */
export function createBindingFile(opts: CreateBindingOpts): BindingFile {
  const { licenseKey, projectPath, machineId } = opts;
  return {
    license_key_hash: createHash('sha256').update(licenseKey).digest('hex').slice(0, 16),
    machine_id: machineId,
    bound_at: new Date().toISOString(),
    token: createBindingToken(licenseKey, projectPath, machineId),
  };
}

/**
 * Read and parse binding.json from a project's .auto-sop directory.
 * Returns null if the file is missing or corrupt.
 */
export async function readBindingFile(projectAutoSopDir: string): Promise<BindingFile | null> {
  try {
    const raw = await fs.readFile(join(projectAutoSopDir, 'binding.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'license_key_hash' in parsed &&
      'machine_id' in parsed &&
      'bound_at' in parsed &&
      'token' in parsed
    ) {
      return parsed as BindingFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify that a binding token matches the given license key, project path, and machine.
 * Recomputes the HMAC and compares with constant-time equality.
 */
export function verifyBindingToken(
  binding: BindingFile,
  licenseKey: string,
  projectPath: string,
  machineId: string,
): boolean {
  const expected = createBindingToken(licenseKey, projectPath, machineId);
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== binding.token.length) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(binding.token, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Atomically write binding.json to disk.
 */
export async function writeBindingFile(
  projectAutoSopDir: string,
  binding: BindingFile,
): Promise<void> {
  const target = join(projectAutoSopDir, 'binding.json');
  await writeFileAtomic(target, JSON.stringify(binding, null, 2) + '\n');
}
