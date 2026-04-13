import { platform } from 'node:os';

export function assertPlatformSupported(): void {
  const current = process.env['CLAUDE_SOP_FAKE_PLATFORM'] ?? platform();
  if (current === 'win32') {
    process.stderr.write('claude-sop: Windows is not supported in v1. Use WSL.\n');
    process.exit(1);
  }
}
