import * as readline from 'node:readline/promises';

export async function promptLicense(defaultText = '123'): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(
      `Enter your claude-sop license key (test key: ${defaultText}): `,
    );
    return answer.trim() || defaultText;
  } finally {
    rl.close();
  }
}

/** The built-in development/test license key. */
export const DEV_LICENSE_KEY = '123';

export function classifyLicense(key: string): 'dev' | 'user' {
  return key === DEV_LICENSE_KEY ? 'dev' : 'user';
}
