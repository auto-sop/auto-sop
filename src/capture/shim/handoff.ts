import { spawn } from 'node:child_process';

export function spawnWriter(payloadPath: string, writerEntry: string): void {
  const child = spawn(process.execPath, [writerEntry, payloadPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
