#!/usr/bin/env node

/**
 * Shim latency benchmark.
 * Measures real Node-to-Node spawn cost using the bench-only shim bundle
 * and a minimal Node writer stub.
 *
 * Usage: node scripts/bench-shim.mjs
 * Requires: npm run build (dist/capture/shim-bench.cjs must exist)
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SHIM_BENCH_PATH = join(PROJECT_ROOT, 'dist', 'capture', 'shim-bench.cjs');
const FIXTURE_PATH = join(
  PROJECT_ROOT,
  'test',
  'fixtures',
  'hook-payloads',
  'user-prompt-submit.json',
);

// Create a minimal real Node writer stub
const WRITER_STUB_PATH = join(tmpdir(), 'bench-writer-stub.cjs');
writeFileSync(WRITER_STUB_PATH, 'process.exit(0);');

const payload = readFileSync(FIXTURE_PATH);

const WARMUP = 10;
const ITERATIONS = 200;

const env = {
  ...process.env,
  CLAUDE_SOP_BENCH_WRITER: WRITER_STUB_PATH,
  CLAUDE_SOP_LEARNER: undefined,
};
// Remove undefined keys (Node env doesn't accept undefined)
delete env.CLAUDE_SOP_LEARNER;

console.log(`Shim Latency Benchmark`);
console.log(`======================`);
console.log(`Shim: ${SHIM_BENCH_PATH}`);
console.log(`Writer stub: ${WRITER_STUB_PATH}`);
console.log(`Payload: ${payload.length} bytes`);
console.log(`Warmup: ${WARMUP}, Iterations: ${ITERATIONS}`);
console.log('');

// Warmup
console.log('Warming up...');
for (let i = 0; i < WARMUP; i++) {
  execFileSync(process.execPath, [SHIM_BENCH_PATH], {
    input: payload,
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10000,
  });
}

// Measurement
console.log('Measuring...');
const samples = [];

for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  execFileSync(process.execPath, [SHIM_BENCH_PATH], {
    input: payload,
    env,
    stdio: ['pipe', 'ignore', 'ignore'],
    timeout: 10000,
  });
  const elapsed = performance.now() - start;
  samples.push(elapsed);
}

// Sort ascending
samples.sort((a, b) => a - b);

const p50 = samples[99];
const p95 = samples[189];
const p99 = samples[197];
const min = samples[0];
const max = samples[samples.length - 1];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

const results = {
  iterations: ITERATIONS,
  warmup: WARMUP,
  p50: Math.round(p50 * 100) / 100,
  p95: Math.round(p95 * 100) / 100,
  p99: Math.round(p99 * 100) / 100,
  min: Math.round(min * 100) / 100,
  max: Math.round(max * 100) / 100,
  mean: Math.round(mean * 100) / 100,
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
};

console.log('');
console.log('Results:');
console.log('--------');
console.log(`  min:  ${results.min.toFixed(2)} ms`);
console.log(`  p50:  ${results.p50.toFixed(2)} ms`);
console.log(`  p95:  ${results.p95.toFixed(2)} ms`);
console.log(`  p99:  ${results.p99.toFixed(2)} ms`);
console.log(`  max:  ${results.max.toFixed(2)} ms`);
console.log(`  mean: ${results.mean.toFixed(2)} ms`);
console.log('');

// Write JSON results
writeFileSync(join(PROJECT_ROOT, 'bench-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log('Wrote bench-results.json');

// Enforce A3 gate
const failures = [];
if (p50 >= 20) failures.push(`p50=${results.p50}ms >= 20ms`);
if (p95 >= 35) failures.push(`p95=${results.p95}ms >= 35ms`);
if (p99 >= 50) failures.push(`p99=${results.p99}ms >= 50ms`);

if (failures.length > 0) {
  console.log('');
  console.error('LATENCY BUDGET EXCEEDED');
  console.error(`Failed thresholds: ${failures.join(', ')}`);
  console.error('Node shim missed A3 thresholds (p50<20 / p95<35 / p99<50).');
  console.error(
    'Escape hatch (pre-authorized in .planning/phases/01-capture-foundation/01-02-PLAN.md):',
  );
  console.error('  Rewrite src/capture/shim/main.ts as a Go binary built with:');
  console.error("    go build -ldflags='-s -w' -o dist/bin/claude-sop-shim-<platform> ./shim-go");
  console.error(
    '  The Go shim consumes stdin, writes tmp file, and execs the Node writer identically.',
  );
  console.error(
    '  Writer (src/capture/writer/*) and all downstream plans (01-03..07) are unaffected.',
  );
  process.exit(1);
} else {
  console.log('A3 gate: PASS');
  process.exit(0);
}
