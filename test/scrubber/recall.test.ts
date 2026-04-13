/**
 * Scrubber recall gate test.
 * Runs the full Scrubber pipeline over a fixture corpus and asserts:
 *   - recall ≥ 0.95 on positives (secrets that MUST be redacted)
 *   - FPR ≤ 0.05 on negatives (benign tokens that MUST NOT be redacted)
 *
 * Emits a deterministic JSON report to:
 *   .planning/phases/00-distribution-decision-foundations/scrubber-recall-report.json
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { installNoNetworkGuards, restoreNetworkGuards } from '../setup/no-network.js';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { createScrubber } from '../../src/scrubber/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RECALL_BUDGET = 0.95;
const FPR_BUDGET = 0.05;

const FIXTURES_DIR = resolve(__dirname, 'fixtures');
const POSITIVES_DIR = join(FIXTURES_DIR, 'positives');
const NEGATIVES_DIR = join(FIXTURES_DIR, 'negatives');
const REPORT_PATH = resolve(
  __dirname,
  '../../.planning/phases/00-distribution-decision-foundations/scrubber-recall-report.json',
);

beforeAll(() => installNoNetworkGuards());
afterAll(() => restoreNetworkGuards());

/** Read non-empty, non-comment lines from a fixture file. */
function readEntries(filePath: string): string[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

interface CategoryResult {
  file: string;
  total: number;
  recalled: number;
  falsePositives: number;
  rate: number;
}

describe('scrubber recall gate', () => {
  it('meets recall and FPR budgets', async () => {
    const scrubber = await createScrubber(); // baseline only, no user packs

    // --- Positives: secrets that MUST be redacted ---
    const positives: CategoryResult[] = [];
    for (const file of readdirSync(POSITIVES_DIR).sort()) {
      if (!file.endsWith('.txt')) continue;
      const entries = readEntries(join(POSITIVES_DIR, file));
      let recalled = 0;
      for (const secret of entries) {
        const { scrubbed } = scrubber.scrub({ payload: secret });
        // For env-assignment entries of form "KEY=VALUE", the "secret" is the VALUE
        const target =
          file === 'env-assignment.txt' && secret.includes('=')
            ? secret.split('=').slice(1).join('=')
            : secret;
        if (!scrubbed.includes(target)) recalled++;
      }
      positives.push({
        file,
        total: entries.length,
        recalled,
        falsePositives: 0,
        rate: entries.length === 0 ? 1 : recalled / entries.length,
      });
    }

    // --- Negatives: benign tokens that MUST NOT be redacted ---
    const negatives: CategoryResult[] = [];
    for (const file of readdirSync(NEGATIVES_DIR).sort()) {
      if (!file.endsWith('.txt')) continue;
      const entries = readEntries(join(NEGATIVES_DIR, file));
      let fp = 0;
      for (const benign of entries) {
        const { scrubbed } = scrubber.scrub({ payload: benign });
        if (!scrubbed.includes(benign)) fp++;
      }
      negatives.push({
        file,
        total: entries.length,
        recalled: 0,
        falsePositives: fp,
        rate: entries.length === 0 ? 0 : fp / entries.length,
      });
    }

    // --- Compute totals ---
    const totalPositives = positives.reduce((a, c) => a + c.total, 0);
    const totalRecalled = positives.reduce((a, c) => a + c.recalled, 0);
    const totalNegatives = negatives.reduce((a, c) => a + c.total, 0);
    const totalFP = negatives.reduce((a, c) => a + c.falsePositives, 0);

    const recall = totalPositives === 0 ? 1 : totalRecalled / totalPositives;
    const fpr = totalNegatives === 0 ? 0 : totalFP / totalNegatives;

    // --- Emit deterministic report ---
    const report = {
      budgets: { fpr: FPR_BUDGET, recall: RECALL_BUDGET },
      generatedAt: 'stable',
      negatives,
      passed: recall >= RECALL_BUDGET && fpr <= FPR_BUDGET,
      positives,
      schemaVersion: 1,
      totals: {
        fpr,
        negatives: totalNegatives,
        positives: totalPositives,
        recall,
      },
    };

    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');

    // --- Assert budgets ---
    console.log(`\nRecall: ${(recall * 100).toFixed(1)}% (budget: ≥${RECALL_BUDGET * 100}%)`);
    console.log(`FPR:    ${(fpr * 100).toFixed(1)}% (budget: ≤${FPR_BUDGET * 100}%)`);
    console.log(`\nPer-category recall:`);
    for (const p of positives) {
      console.log(`  ${p.file}: ${p.recalled}/${p.total} = ${(p.rate * 100).toFixed(1)}%`);
    }
    console.log(`\nPer-category FPR:`);
    for (const n of negatives) {
      console.log(`  ${n.file}: ${n.falsePositives}/${n.total} = ${(n.rate * 100).toFixed(1)}%`);
    }

    expect(recall).toBeGreaterThanOrEqual(RECALL_BUDGET);
    expect(fpr).toBeLessThanOrEqual(FPR_BUDGET);
  });
});
