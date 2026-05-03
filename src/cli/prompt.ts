import * as readline from 'node:readline/promises';
import { APP_BASE_URL } from '../config/environment.js';

export async function promptLicense(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `Enter your license key (get one free at ${APP_BASE_URL}/signup): `,
    );
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      throw new Error(`License key is required. Get a free key at ${APP_BASE_URL}/signup`);
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

export function classifyLicense(key: string): 'dev' | 'user' {
  return key.startsWith('dev-') ? 'dev' : 'user';
}
