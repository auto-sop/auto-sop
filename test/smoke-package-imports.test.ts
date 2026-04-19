/**
 * P5 — Dual ESM + CJS smoke test.
 *
 * Packs auto-sop into a tarball, installs it into a temporary project,
 * then spawns ESM (import) and CJS (require) consumers to verify the
 * published package works for both module systems.
 *
 * Requires `npm run build` before running (invoked via test:smoke).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

describe('smoke: dual ESM + CJS package imports', () => {
  let tmpDir: string;
  let tgzPath: string;

  // Pack once, reuse for both tests
  afterAll(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * One-time setup: pack the tarball and install into a temp project.
   * Called lazily on first test so vitest sees it inside the suite.
   */
  function ensureInstalled(): string {
    if (tmpDir) return tmpDir;

    // Pack into a temp location to avoid polluting the repo
    const packDir = mkdtempSync(resolve(tmpdir(), 'auto-sop-pack-'));
    const packOutput = execSync('npm pack --pack-destination ' + packDir, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    // npm pack prints the filename on the last line
    const tgzName = packOutput.split('\n').pop()!.trim();
    tgzPath = resolve(packDir, tgzName);

    // Create a temp project and install the tarball
    tmpDir = mkdtempSync(resolve(tmpdir(), 'auto-sop-imports-'));

    // Minimal package.json (NOT type:module — we test both systems)
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-imports', version: '1.0.0', private: true }),
    );

    execSync(`npm install "${tgzPath}"`, {
      cwd: tmpDir,
      timeout: 60000,
      stdio: 'pipe',
    });

    // Write ESM test script
    writeFileSync(
      join(tmpDir, 'test-esm.mjs'),
      [
        'import { PathResolver, loadConfig, assertPlatformSupported } from "auto-sop";',
        'if (typeof PathResolver !== "function") { process.exit(1); }',
        'if (typeof loadConfig !== "function") { process.exit(1); }',
        'if (typeof assertPlatformSupported !== "function") { process.exit(1); }',
        'console.log("ESM OK");',
      ].join('\n'),
    );

    // Write CJS test script
    writeFileSync(
      join(tmpDir, 'test-cjs.cjs'),
      [
        'const pkg = require("auto-sop");',
        'if (typeof pkg.PathResolver !== "function") { process.exit(1); }',
        'if (typeof pkg.loadConfig !== "function") { process.exit(1); }',
        'if (typeof pkg.assertPlatformSupported !== "function") { process.exit(1); }',
        'console.log("CJS OK");',
      ].join('\n'),
    );

    // Cleanup the pack temp dir (tarball already installed)
    rmSync(packDir, { recursive: true, force: true });

    return tmpDir;
  }

  it('ESM import resolves and exports are callable', () => {
    const dir = ensureInstalled();
    const result = execSync('node test-esm.mjs', {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.trim()).toBe('ESM OK');
  }, 90000);

  it('CJS require resolves and exports are callable', () => {
    const dir = ensureInstalled();
    const result = execSync('node test-cjs.cjs', {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.trim()).toBe('CJS OK');
  }, 90000);
});
