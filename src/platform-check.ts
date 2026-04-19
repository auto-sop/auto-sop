import { platform } from 'node:os';

export function assertPlatformSupported(): void {
  const current = process.env['AUTO_SOP_FAKE_PLATFORM'] ?? process.env['CLAUDE_SOP_FAKE_PLATFORM'] ?? platform();
  const supported = ['darwin', 'linux', 'win32'];
  if (!supported.includes(current)) {
    process.stderr.write(`auto-sop: unsupported platform "${current}".\n`);
    process.exit(1);
  }
}
