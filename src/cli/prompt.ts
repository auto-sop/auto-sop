import * as readline from 'node:readline/promises';
import { APP_BASE_URL } from '../config/environment.js';
import { browserAuth } from './browser-auth.js';

export async function promptLicense(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Non-interactive mode detected. Use --license <key> flag to provide a license key.',
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `Press Enter to open browser, or paste license key: `,
    );
    const trimmed = answer.trim();
    if (trimmed.length > 0) {
      // User pasted a key directly
      return trimmed;
    }
    // User pressed Enter with no input — launch browser auth
  } finally {
    rl.close();
  }

  return browserAuth();
}

export function classifyLicense(key: string): 'dev' | 'user' {
  return key.startsWith('dev-') ? 'dev' : 'user';
}
