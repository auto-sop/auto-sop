/**
 * Regenerate `<name>.md` input fixtures from their declarative descriptors.
 *
 * Why it exists:
 *   CRLF, 500 KB payloads, and trailing whitespace are all vulnerable to
 *   accidental rewriting by editors, formatters, and git-autocrlf. Storing
 *   the fixtures declaratively (see fixtures.ts) and regenerating them from
 *   bytes guarantees that whatever lands in the repo is what the tests ran
 *   against locally.
 *
 * Usage:
 *   GOLDEN_UPDATE=1 tsx test/managed-section/golden/write-fixtures.ts
 *
 * The `GOLDEN_UPDATE=1` gate prevents accidental runs from CI or from a
 * fat-fingered npm script — fixture regen must be a deliberate act that a
 * reviewer will see in the diff.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOLDEN_FIXTURES } from './fixtures.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function main(): void {
  if (process.env['GOLDEN_UPDATE'] !== '1') {
    // eslint-disable-next-line no-console
    console.error(
      'Refusing to regenerate golden inputs without GOLDEN_UPDATE=1.',
    );
    process.exit(1);
  }

  for (const fx of GOLDEN_FIXTURES) {
    const input = fx.buildInput();
    const target = join(here, `${fx.name}.md`);
    if (input === null) {
      // The "fresh project" case: the fixture has no `.md` counterpart on
      // disk. We write a zero-byte sentinel so the fixture is discoverable
      // and its presence is explicit in the repo. The golden test detects
      // this sentinel and feeds `null` to the renderer.
      writeFileSync(`${target}.null`, '');
      // eslint-disable-next-line no-console
      console.log(`wrote ${fx.name}.md.null (null-input sentinel)`);
      continue;
    }
    writeFileSync(target, input);
    // eslint-disable-next-line no-console
    console.log(
      `wrote ${fx.name}.md (${input.length} bytes) — ${fx.describe}`,
    );
  }
}

main();
