/**
 * E7 — Golden-file regression suite.
 *
 * Proves that `renderManagedSection` (the pure string-only render function
 * behind `writeManagedSection`) preserves every byte outside the managed
 * markers, across eight edge-case inputs. Any single-byte deviation fails
 * the suite loudly with a unified diff.
 *
 * Why this test exists:
 *   The editor has three splice branches (no file / no markers / has
 *   markers) and every change to `renderManagedSection`, `findMarkers`, or
 *   `buildSectionBlock` risks perturbing bytes we promised not to touch.
 *   Unit tests cover behaviour; golden tests nail down exact output.
 *
 * To intentionally change the rendered output:
 *   1. Change the code.
 *   2. Run `npm run test:golden:update` (regenerates `.expected.md`).
 *   3. Review the byte-level diff in the PR — reviewers see every changed
 *      character.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderManagedSection } from '../../src/managed-section/editor.js';
import { GOLDEN_FIXTURES } from './golden/fixtures.js';

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));

/**
 * Load the input for a fixture. Returns null when the fixture declares a
 * "fresh-project" scenario via the `<name>.md.null` sentinel. Otherwise
 * returns the UTF-8-decoded bytes of `<name>.md`.
 */
function loadInput(name: string): string | null {
  const nullSentinel = join(goldenDir, `${name}.md.null`);
  if (existsSync(nullSentinel)) {
    return null;
  }
  return readFileSync(join(goldenDir, `${name}.md`), 'utf-8');
}

/**
 * Produce a unified-diff-ish summary for a byte mismatch. Keeps output
 * bounded so a 500 KB fixture diff doesn't drown the test log. We report:
 *   - byte length delta
 *   - the first differing byte's offset + a context window around it
 *   - a hint about the most likely category of failure
 */
function formatByteDiff(expected: Buffer, actual: Buffer): string {
  const lines: string[] = [];
  lines.push(`expected ${expected.length} bytes, got ${actual.length} bytes`);
  const len = Math.min(expected.length, actual.length);
  let firstDiff = -1;
  for (let i = 0; i < len; i++) {
    if (expected[i] !== actual[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1 && expected.length !== actual.length) {
    firstDiff = len; // diverge at EOF of shorter buffer
  }
  if (firstDiff === -1) {
    lines.push('(no byte difference detected — this is a test bug)');
    return lines.join('\n');
  }

  const windowStart = Math.max(0, firstDiff - 40);
  const windowEnd = Math.min(
    Math.max(expected.length, actual.length),
    firstDiff + 40,
  );
  const expectedHex = expected
    .slice(windowStart, windowEnd)
    .toString('hex');
  const actualHex = actual.slice(windowStart, windowEnd).toString('hex');
  const expectedSnippet = JSON.stringify(
    expected.slice(windowStart, windowEnd).toString('utf-8'),
  );
  const actualSnippet = JSON.stringify(
    actual.slice(windowStart, windowEnd).toString('utf-8'),
  );

  lines.push(`first byte diff at offset ${firstDiff}`);
  lines.push(`  expected [0x${windowStart.toString(16)}..]: ${expectedSnippet}`);
  lines.push(`  actual   [0x${windowStart.toString(16)}..]: ${actualSnippet}`);
  lines.push(`  expected hex: ${expectedHex}`);
  lines.push(`  actual   hex: ${actualHex}`);
  lines.push(
    '  If CRLF is involved, check git autocrlf / .gitattributes.',
  );
  lines.push(
    '  If the change was intentional, run `npm run test:golden:update`.',
  );
  return lines.join('\n');
}

describe('managed-section golden files (E7)', () => {
  // Safety rail: we expect exactly 8 fixtures. A fixture disappearing is
  // itself a regression — we deliberately hard-code the count.
  it('has the expected fixture count', () => {
    expect(GOLDEN_FIXTURES).toHaveLength(8);
  });

  for (const fx of GOLDEN_FIXTURES) {
    it(`${fx.name} — ${fx.describe}`, () => {
      const input = loadInput(fx.name);
      const rendered = renderManagedSection(input, fx.body);
      const actualBytes = Buffer.from(rendered, 'utf-8');

      const expectedPath = join(goldenDir, `${fx.name}.expected.md`);
      const expectedBytes = readFileSync(expectedPath);

      if (!actualBytes.equals(expectedBytes)) {
        // Vitest's toEqual() diffs strings up to a length cap. For large
        // fixtures we fall back to a compact unified-ish diff ourselves.
        throw new Error(
          `Golden mismatch for ${fx.name}\n${formatByteDiff(
            expectedBytes,
            actualBytes,
          )}`,
        );
      }
      // Even when the assertion above passes, include a positive assertion
      // so vitest reports the test as having asserted something.
      expect(actualBytes.equals(expectedBytes)).toBe(true);
    });
  }

  // Extra coverage: the renderer must be idempotent. Running it on the
  // already-rendered output with the same body must produce identical
  // bytes — this is the invariant that keeps `recap --run` from
  // pointlessly rewriting CLAUDE.md on every invocation.
  for (const fx of GOLDEN_FIXTURES) {
    it(`${fx.name} — idempotent re-render`, () => {
      const input = loadInput(fx.name);
      const first = renderManagedSection(input, fx.body);
      const second = renderManagedSection(first, fx.body);
      expect(second).toBe(first);
    });
  }
});
