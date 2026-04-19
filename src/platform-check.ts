import { platform } from 'node:os';

export function assertPlatformSupported(): void {
  const current = process.env['AUTO_SOP_FAKE_PLATFORM'] ?? process.env['CLAUDE_SOP_FAKE_PLATFORM'] ?? platform();
  if (current === 'win32') {
    process.stderr.write('auto-sop: Windows is not supported in v1. Use WSL.\n');
    process.exit(1);
  }
}
