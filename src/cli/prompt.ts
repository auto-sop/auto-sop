import * as readline from 'node:readline/promises';

export async function promptLicense(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      'Enter your license key (get one free at https://app.auto-sop.com/signup): ',
    );
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      throw new Error('License key is required. Get a free key at https://app.auto-sop.com/signup');
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

export function classifyLicense(key: string): 'dev' | 'user' {
  return key.startsWith('dev-') ? 'dev' : 'user';
}
