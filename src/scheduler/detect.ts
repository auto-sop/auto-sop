import { execa } from 'execa';

export async function systemdUserAvailable(): Promise<boolean> {
  try {
    const r = await execa('systemctl', ['--user', 'is-system-running'], {
      reject: false,
      timeout: 2000,
    });
    // running, degraded, starting, initializing, maintenance all mean bus is up
    if (r.exitCode === 0) return true;
    return /running|degraded|starting|initializing|maintenance/.test(r.stdout || '');
  } catch {
    return false;
  }
}
