/**
 * Browser-based device code authentication flow.
 * Similar to Claude Code's device auth: generates a one-time code,
 * opens the browser, and polls until the user approves.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { API_BASE_URL } from '../config/environment.js';

/** Timeout for HTTP requests in milliseconds. */
const FETCH_TIMEOUT_MS = 10_000;

/** Polling interval in milliseconds (3 seconds). */
const POLL_INTERVAL_MS = 3_000;

/** Maximum number of polls before timeout (~10 minutes). */
const MAX_POLLS = 200;

interface DeviceCodeResponse {
  code: string;
  login_url: string;
}

interface PollResponse {
  status: 'pending' | 'approved' | 'expired';
  license_key?: string;
}

/**
 * Open a URL in the user's default browser.
 * Uses platform-specific commands; fails silently if browser can't be opened.
 * Uses spawn() with args array to prevent command injection via malicious URLs.
 */
function openBrowser(url: string): void {
  const os = platform();
  let bin: string;
  let args: string[];

  if (os === 'darwin') {
    bin = 'open';
    args = [url];
  } else if (os === 'win32') {
    bin = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    bin = 'xdg-open';
    args = [url];
  }

  // spawn() with args array bypasses shell interpretation entirely
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Initiate browser-based device code authentication.
 * Returns the license key on success, throws on expiry or timeout.
 */
export async function browserAuth(): Promise<string> {
  // 1. Request a device code from the server
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let deviceCode: DeviceCodeResponse;
  try {
    const response = await fetch(`${API_BASE_URL}/cli/device-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to create device code (HTTP ${response.status}): ${text}`);
    }

    deviceCode = (await response.json()) as DeviceCodeResponse;
  } finally {
    clearTimeout(timeout);
  }

  // 2. Open browser
  openBrowser(deviceCode.login_url);

  // 3. Print instructions
  process.stdout.write('\n  Opening browser to sign in...\n');
  process.stdout.write('  If browser doesn\'t open, visit:\n');
  process.stdout.write(`  ${deviceCode.login_url}\n\n`);
  process.stdout.write('  Waiting for authorization...');

  // 4. Poll until approved, expired, or timeout
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write('.');

    const pollController = new AbortController();
    const pollTimeout = setTimeout(() => pollController.abort(), FETCH_TIMEOUT_MS);

    let pollResult: PollResponse;
    try {
      const pollResponse = await fetch(
        `${API_BASE_URL}/cli/device-code/poll?code=${encodeURIComponent(deviceCode.code)}`,
        { signal: pollController.signal },
      );

      if (pollResponse.status === 429) {
        // Rate limited — terminal error
        process.stdout.write('\n');
        throw new Error('Too many requests. Run command again.');
      }

      if (!pollResponse.ok) {
        // 5xx or other server error — retryable, keep polling
        continue;
      }

      pollResult = (await pollResponse.json()) as PollResponse;
    } catch (err) {
      // Re-throw intentional errors (rate limit, etc.)
      if (err instanceof Error && err.message.includes('Too many requests')) throw err;
      // Network error during poll — retry
      continue;
    } finally {
      clearTimeout(pollTimeout);
    }

    if (pollResult.status === 'approved' && pollResult.license_key) {
      process.stdout.write('\n');
      return pollResult.license_key;
    }

    if (pollResult.status === 'expired') {
      process.stdout.write('\n');
      throw new Error('Device code expired. Run command again.');
    }
  }

  process.stdout.write('\n');
  throw new Error('Authorization timed out. Run command again.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
