import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { hostname, platform, userInfo } from 'node:os';
import { readFileSync } from 'node:fs';

const FALLBACK_SALT = 'claude-sop-machine-id-fallback-v1'; // kept for stability (changing would alter machine IDs)

let cachedId: string | undefined;

export async function getMachineId(): Promise<string> {
  if (cachedId !== undefined) return cachedId;
  cachedId = getPlatformMachineId();
  return cachedId;
}

function getPlatformMachineId(): string {
  try {
    const os = platform();
    if (os === 'darwin') {
      const out = execSync(
        '/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice',
        { encoding: 'utf8', timeout: 5000 },
      );
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1].toLowerCase();
    } else if (os === 'linux') {
      const id = readFileSync('/etc/machine-id', 'utf8').trim();
      if (id.length > 0) return id;
    } else if (os === 'win32') {
      const out = execSync(
        'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf8', timeout: 5000 },
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+(.+)/);
      if (match?.[1]) return match[1].trim().toLowerCase();
    }
  } catch {
    // fall through to deterministic hostname+uid fallback
  }
  const fallbackInput = `${hostname()}::${userInfo().uid}::${FALLBACK_SALT}`;
  return createHash('sha256').update(fallbackInput).digest('hex');
}
