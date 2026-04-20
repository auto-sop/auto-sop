/**
 * Declarative fixture descriptors for the E7 golden-file test suite.
 *
 * Each descriptor owns:
 *   - a `name` (used for on-disk filenames: <name>.md + <name>.expected.md)
 *   - a `describe` one-liner explaining the edge case under test
 *   - a `buildInput()` that returns a `Buffer` OR `null` (null means
 *     "CLAUDE.md does not exist yet" and exercises the fresh-project branch)
 *   - a `body` string fed to `renderManagedSection` as the new managed-
 *     section body.
 *
 * The inputs are deliberately generated programmatically (as `Buffer`) so
 * that exotic bytes — CRLF, unicode, trailing whitespace, 500 KB payloads —
 * survive any editor / git-autocrlf / linter round-trip. We write the
 * fixtures to disk via the companion `write-fixtures.ts` helper and keep
 * `.expected.md` under source control as byte-exact artifacts.
 */
import {
  BEGIN_MARKER,
  GENERATED_COMMENT,
  END_MARKER,
} from '../../../src/managed-section/markers.js';

export interface GoldenFixture {
  /** Stem of fixture filenames — `<name>.md` + `<name>.expected.md`. */
  name: string;
  /** Short human description of the edge case under test. */
  describe: string;
  /** Produce the bytes of `<name>.md`, or null for "no CLAUDE.md yet". */
  buildInput: () => Buffer | null;
  /** Managed-section body passed to the renderer. */
  body: string;
}

/**
 * Fixed managed-section body used across every fixture. Keeping the body
 * constant isolates the variable under test — the INPUT's content outside
 * the markers — so a fixture failure unambiguously points at the editor's
 * handling of that input, not at an unrelated change in directive rendering.
 */
export const GOLDEN_BODY = [
  '## Project rules',
  '',
  '- **Do not commit to main.**',
  '  _(evidence: 3 sessions · [view turns](./.auto-sop/captures/s1/turns/t1.json))_',
  '',
  '- **Run tests before push.**',
  '  _(evidence: 2 sessions · [view turns](./.auto-sop/captures/s2/turns/t1.json))_',
].join('\n');

// ─── Helpers ─────────────────────────────────────────────

function utf8(s: string): Buffer {
  return Buffer.from(s, 'utf-8');
}

function existingSectionBlock(bodyLines: string[]): string {
  return [BEGIN_MARKER, GENERATED_COMMENT, '', ...bodyLines, '', END_MARKER].join('\n');
}

// ─── Fixtures ────────────────────────────────────────────

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  // 01 — Fresh project: CLAUDE.md does not exist yet. Exercises the
  //      CLAUDE_MD_HEADER + new section branch.
  {
    name: 'golden-01-fresh-project',
    describe: 'no CLAUDE.md on disk — editor creates from scratch',
    buildInput: () => null,
    body: GOLDEN_BODY,
  },

  // 02 — Existing managed section: editor replaces only the marker-bounded
  //      region; all surrounding user prose, fences, and rules must survive
  //      byte-for-byte.
  {
    name: 'golden-02-existing-section',
    describe: 'existing markers + previous directives — splice-only replace',
    buildInput: () => {
      const prelude = [
        '# My Project',
        '',
        'Custom user rules that absolutely must not move:',
        '',
        '- Prefer pnpm',
        '- Always sign commits',
        '',
        '---',
        '',
      ].join('\n');
      const priorSection = existingSectionBlock([
        '## Old body',
        '',
        '- **Old rule A.**',
        '- **Old rule B.**',
      ]);
      const postlude = '\n\n## Notes\n\nTrailing user content lives here.\n';
      return utf8(prelude + priorSection + postlude);
    },
    body: GOLDEN_BODY,
  },

  // 03 — CRLF line endings throughout. The editor must NOT normalise user
  //      content to LF. Only the managed section itself will be LF-terminated
  //      (the renderer is LF-only by design); CRLF in the prelude/postlude
  //      must survive.
  {
    name: 'golden-03-crlf-line-endings',
    describe: 'Windows CRLF outside markers — preserved byte-exact',
    buildInput: () => {
      const lines = [
        '# CRLF Project',
        '',
        'Every line here ends with \\r\\n.',
        '',
        'Section A:',
        '- item 1',
        '- item 2',
        '',
      ];
      return utf8(lines.join('\r\n'));
    },
    body: GOLDEN_BODY,
  },

  // 04 — Multibyte unicode outside markers. Emoji (4-byte UTF-8), CJK,
  //      combining marks, and Polish diacritics each exercise different
  //      UTF-8 paths. Byte count != code-point count; the renderer must
  //      splice by byte offset so these are preserved.
  {
    name: 'golden-04-emoji-and-unicode',
    describe: 'emoji + CJK + combining marks preserved outside markers',
    buildInput: () => {
      const lines = [
        '# 🎨 Design Doc 中文版',
        '',
        'Polish: zażółć gęślą jaźń.',
        'CJK: 你好世界。这是一个测试。',
        'Emoji: 🚀🔥✨🎉 (with ZWJ: 👨‍👩‍👧‍👦)',
        'Combining marks: café (e + U+0301) vs café (precomposed).',
        '',
      ];
      return utf8(lines.join('\n'));
    },
    body: GOLDEN_BODY,
  },

  // 05 — Trailing whitespace (spaces + tabs) outside markers. The editor
  //      must NOT "clean up" these whitespace artefacts — they may be
  //      intentional (markdown hard-breaks) or simply user style.
  {
    name: 'golden-05-trailing-whitespace',
    describe: 'trailing spaces + tabs outside markers preserved',
    buildInput: () => {
      // Each line deliberately ends with distinct trailing whitespace.
      const lines = [
        '# Trailing WS Doctorate   ', // 3 trailing spaces
        '',
        'Line with trailing tab:\t', // single trailing tab
        'Line with trailing mix:  \t\t ', // mix of spaces + tabs
        'Normal line.',
        '', // intentional blank
        'Final line.    ', // 4 trailing spaces
      ];
      return utf8(lines.join('\n') + '\n');
    },
    body: GOLDEN_BODY,
  },

  // 06 — Marker-LIKE strings inside a fenced code block must NOT be
  //      confused for real markers. We use marker variants (v2 / lowercase)
  //      that intentionally do NOT byte-match the real markers, proving
  //      findMarkers is strict (exact string match, not regex).
  //
  //      If someone ever changes findMarkers to accept a looser match, this
  //      fixture will fail loudly: the editor would either throw
  //      AmbiguousMarkersError, or splice through the code block — both
  //      produce non-matching bytes.
  {
    name: 'golden-06-markers-in-code-block',
    describe: 'marker-like strings in fenced code block — not real markers',
    buildInput: () => {
      const lines = [
        '# Docs about the managed section',
        '',
        'Here is what the markers look like:',
        '',
        '```html',
        '<!-- auto-sop:managed-section:begin v2 -->',
        '  your directives here',
        '<!-- auto-sop:managed-section:end-legacy -->',
        '```',
        '',
        'The editor should leave the code block alone.',
        '',
      ];
      return utf8(lines.join('\n'));
    },
    body: GOLDEN_BODY,
  },

  // 07 — Very large file (≥500 KB) of content outside markers. Proves the
  //      splice is O(n) over bytes, not quadratic, and that no intermediate
  //      representation re-encodes the payload.
  {
    name: 'golden-07-very-large',
    describe: '≥500 KB prelude — large-file splice preserves bytes',
    buildInput: () => {
      // A deterministic, non-trivial repeating block (~100 bytes). We repeat
      // it until total bytes > 500 KB.
      const block = 'The quick brown fox jumps over the lazy dog. 0123456789 — abcdefghij\n';
      const blockBytes = Buffer.byteLength(block, 'utf-8');
      const reps = Math.ceil((500 * 1024) / blockBytes) + 1;
      const body = block.repeat(reps);
      return utf8('# Large Fixture\n\n' + body + '\nEnd marker sentinel.\n');
    },
    body: GOLDEN_BODY,
  },

  // 08 — Marker at exact EOF, no trailing newline. Stresses the
  //      markers.endAfter computation that optionally swallows a trailing
  //      '\n'. The renderer must still produce a consistent newline
  //      discipline without producing stray bytes.
  {
    name: 'golden-08-exact-byte-boundary',
    describe: 'END_MARKER at EOF with no trailing newline',
    buildInput: () => {
      const prelude = '# Tight EOF\n\nUser content.\n\n';
      const section = existingSectionBlock(['## Old', '', '- Old directive.']);
      // Intentionally NO trailing newline after END_MARKER.
      return utf8(prelude + section);
    },
    body: GOLDEN_BODY,
  },
];
