import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

const FALLBACK_SALT = 'claude-sop-machine-id-fallback-v1'; // kept for stability (changing would alter machine IDs)

export async function getMachineId(): Promise<string> {
  try {
    // Dynamic import so this file remains testable without the dep installed
    const mod = await import('node-machine-id');
    const id = await mod.machineId(true);
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    // fall through to deterministic hostname+uid fallback
  }
  const fallbackInput = `${hostname()}::${userInfo().uid}::${FALLBACK_SALT}`;
  return createHash('sha256').update(fallbackInput).digest('hex');
}
