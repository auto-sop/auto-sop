#!/usr/bin/env tsx
/**
 * Standalone recall report runner.
 * Invokes the recall test via vitest and prints a summary.
 * Usage: npx tsx scripts/scrubber-recall-report.ts
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPORT_PATH = resolve(
  __dirname,
  '../.planning/phases/00-distribution-decision-foundations/scrubber-recall-report.json',
);

try {
  execSync('npx vitest run test/scrubber/recall.test.ts --reporter=verbose', {
    stdio: 'inherit',
    cwd: resolve(__dirname, '..'),
  });
} catch {
  console.error('\n❌ Recall test failed. See output above.');
  process.exit(1);
}

try {
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  console.log('\n=== Scrubber Recall Report ===');
  console.log(`Recall: ${(report.totals.recall * 100).toFixed(1)}%`);
  console.log(`FPR:    ${(report.totals.fpr * 100).toFixed(1)}%`);
  console.log(`Passed: ${report.passed ? '✅' : '❌'}`);
} catch {
  console.error('Could not read report file.');
  process.exit(1);
}
