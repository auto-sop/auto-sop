/**
 * Regenerate the `<name>.expected.md` artifacts from the current renderer.
 *
 * Run this after an INTENTIONAL change to `renderManagedSection` or to the
 * fixture descriptors. The emitted `.expected.md` files are what the golden
 * test asserts against on every run — so whatever bytes this script writes
 * are what the next CI run will enforce.
 *
 * Usage:
 *   GOLDEN_UPDATE=1 tsx test/managed-section/golden/update-goldens.ts
 *
 * Or via the package script:
 *   npm run test:golden:update
 *
 * The `GOLDEN_UPDATE=1` gate is a safety rail: without it the script refuses
 * to run, so an accidental `tsx` invocation on CI cannot silently rubber-
 * stamp a regression. Reviewers should see byte-level diffs in the PR.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderManagedSection } from '../../../src/managed-section/editor.js';
import { GOLDEN_FIXTURES } from './fixtures.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function loadInput(name: string): string | null {
  // Null-input sentinel → renderer receives null (fresh-project branch).
  const nullSentinel = join(here, `${name}.md.null`);
  if (existsSync(nullSentinel)) {
    return null;
  }
  const inputPath = join(here, `${name}.md`);
  // Read as UTF-8 — renderManagedSection operates on strings. The Buffer
  // representation we assert on at test time is the re-encoded UTF-8 of that
  // string, which is a round-trip identity for valid UTF-8.
  return readFileSync(inputPath, 'utf-8');
}

function main(): void {
  if (process.env['GOLDEN_UPDATE'] !== '1') {
    console.error('Refusing to regenerate golden expected outputs without GOLDEN_UPDATE=1.');
    process.exit(1);
  }

  for (const fx of GOLDEN_FIXTURES) {
    const input = loadInput(fx.name);
    const rendered = renderManagedSection(input, fx.body);
    const bytes = Buffer.from(rendered, 'utf-8');
    const target = join(here, `${fx.name}.expected.md`);
    writeFileSync(target, bytes);
    console.log(`wrote ${fx.name}.expected.md (${bytes.length} bytes) — ${fx.describe}`);
  }
}

main();
