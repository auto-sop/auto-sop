/**
 * Unit tests for src/learner/error-prevention.ts
 *
 * Covers:
 *   - detectPreventedErrors: matching logic, timestamp filtering, session exclusion
 *   - appendPreventedErrors / readPreventedErrors: JSONL I/O round-trip
 *   - compactPreventedErrors: age-based eviction
 *   - Edge cases: empty inputs, no matching fingerprints, deduplication
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPreventedErrors,
  appendPreventedErrors,
  readPreventedErrors,
  compactPreventedErrors,
  type PreventedError,
  type DirectiveFingerprint,
} from '../../src/learner/error-prevention.js';
import type { TurnData, ToolCall } from '../../src/learner/turn-loader.js';

// ─── Helpers ─────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-prevention-'));
}

function makeTurn(overrides: Partial<TurnData> & { tool_calls: ToolCall[] }): TurnData {
  return {
    turn_id: 'turn-001',
    session_id: 'sess-new',
    agent: 'main',
    finalized_at: '2026-04-15T12:00:00Z',
    ...overrides,
  };
}

function makePreCall(
  toolUseId: string,
  command: string,
  t: string = '2026-04-15T12:00:00Z',
): ToolCall {
  return {
    event: 'pre',
    tool_use_id: toolUseId,
    tool: 'Bash',
    input: { command },
    t,
  };
}

function makePostCall(
  toolUseId: string,
  success: boolean,
  t: string = '2026-04-15T12:00:01Z',
): ToolCall {
  return {
    event: 'post',
    tool_use_id: toolUseId,
    tool: 'Bash',
    success,
    t,
  };
}

function makeFingerprint(overrides: Partial<DirectiveFingerprint> = {}): DirectiveFingerprint {
  return {
    directive_id: 'repeated-bash-failure-abc123',
    source_fingerprint: 'npm test',
    first_seen: '2026-04-01T00:00:00Z',
    evidence_sessions: ['sess-old-1', 'sess-old-2', 'sess-old-3'],
    ...overrides,
  };
}

// ─── Detection Tests ─────────────────────────────────────

describe('detectPreventedErrors', () => {
  it('detects a prevented error when successful command matches a known failure fingerprint', () => {
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-new',
        finalized_at: '2026-04-15T12:00:00Z',
        tool_calls: [makePreCall('tu1', 'npm test'), makePostCall('tu1', true)],
      }),
    ];
    const fps = [makeFingerprint({ source_fingerprint: 'npm test' })];

    const result = detectPreventedErrors(turns, fps);

    expect(result).toHaveLength(1);
    expect(result[0]!.directive_id).toBe('repeated-bash-failure-abc123');
    expect(result[0]!.source_fingerprint).toBe('npm test');
    expect(result[0]!.session_id).toBe('sess-new');
    expect(result[0]!.command_preview).toBe('npm test');
  });

  it('does NOT count failed commands', () => {
    const turns: TurnData[] = [
      makeTurn({
        tool_calls: [
          makePreCall('tu1', 'npm test'),
          makePostCall('tu1', false), // failed
        ],
      }),
    ];
    const fps = [makeFingerprint({ source_fingerprint: 'npm test' })];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(0);
  });

  it('does NOT count if turn timestamp is before directive first_seen', () => {
    const turns: TurnData[] = [
      makeTurn({
        finalized_at: '2026-03-15T12:00:00Z', // BEFORE first_seen
        tool_calls: [
          makePreCall('tu1', 'npm test', '2026-03-15T12:00:00Z'),
          makePostCall('tu1', true, '2026-03-15T12:00:01Z'),
        ],
      }),
    ];
    const fps = [makeFingerprint({ first_seen: '2026-04-01T00:00:00Z' })];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(0);
  });

  it('does NOT count if session is in the directive evidence sessions', () => {
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-old-1', // matches evidence session
        tool_calls: [makePreCall('tu1', 'npm test'), makePostCall('tu1', true)],
      }),
    ];
    const fps = [
      makeFingerprint({ evidence_sessions: ['sess-old-1', 'sess-old-2', 'sess-old-3'] }),
    ];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(0);
  });

  it('returns empty for empty turns', () => {
    const fps = [makeFingerprint()];
    expect(detectPreventedErrors([], fps)).toHaveLength(0);
  });

  it('returns empty for empty fingerprints', () => {
    const turns: TurnData[] = [
      makeTurn({
        tool_calls: [makePreCall('tu1', 'npm test'), makePostCall('tu1', true)],
      }),
    ];
    expect(detectPreventedErrors(turns, [])).toHaveLength(0);
  });

  it('returns empty when command does not match any fingerprint', () => {
    const turns: TurnData[] = [
      makeTurn({
        tool_calls: [makePreCall('tu1', 'npm run build'), makePostCall('tu1', true)],
      }),
    ];
    const fps = [makeFingerprint({ source_fingerprint: 'npm test' })];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(0);
  });

  it('deduplicates same fingerprint+session+directive within one tick', () => {
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-new',
        tool_calls: [
          makePreCall('tu1', 'npm test'),
          makePostCall('tu1', true),
          makePreCall('tu2', 'npm test'),
          makePostCall('tu2', true),
        ],
      }),
    ];
    const fps = [makeFingerprint({ source_fingerprint: 'npm test' })];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(1); // deduplicated
  });

  it('caps command_preview at 80 chars', () => {
    const longCommand = 'x'.repeat(200);
    const turns: TurnData[] = [
      makeTurn({
        tool_calls: [makePreCall('tu1', longCommand), makePostCall('tu1', true)],
      }),
    ];
    // fingerprintCommand caps at 100 chars, so use a matching 100-char fingerprint
    const fp100 = longCommand.slice(0, 100);
    const fps = [makeFingerprint({ source_fingerprint: fp100 })];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(1);
    expect(result[0]!.command_preview.length).toBe(80);
  });

  it('handles multiple fingerprints matching different commands', () => {
    const turns: TurnData[] = [
      makeTurn({
        tool_calls: [
          makePreCall('tu1', 'npm test'),
          makePostCall('tu1', true),
          makePreCall('tu2', 'npm run lint'),
          makePostCall('tu2', true),
        ],
      }),
    ];
    const fps = [
      makeFingerprint({ directive_id: 'dir-1', source_fingerprint: 'npm test' }),
      makeFingerprint({ directive_id: 'dir-2', source_fingerprint: 'npm run lint' }),
    ];

    const result = detectPreventedErrors(turns, fps);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.directive_id).sort()).toEqual(['dir-1', 'dir-2']);
  });
});

// ─── I/O Tests ───────────────────────────────────────────

describe('appendPreventedErrors + readPreventedErrors', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('round-trips prevented errors through JSONL', () => {
    const errors: PreventedError[] = [
      {
        t: '2026-04-15T12:00:00Z',
        directive_id: 'dir-1',
        source_fingerprint: 'npm test',
        session_id: 'sess-1',
        command_preview: 'npm test',
      },
      {
        t: '2026-04-15T13:00:00Z',
        directive_id: 'dir-2',
        source_fingerprint: 'npm run lint',
        session_id: 'sess-2',
        command_preview: 'npm run lint',
      },
    ];

    appendPreventedErrors(stateDir, errors);
    const result = readPreventedErrors(stateDir);

    expect(result).toHaveLength(2);
    expect(result[0]!.directive_id).toBe('dir-1');
    expect(result[1]!.directive_id).toBe('dir-2');
  });

  it('returns empty for missing file', () => {
    const result = readPreventedErrors(stateDir);
    expect(result).toHaveLength(0);
  });

  it('skips malformed lines', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'error-prevention.jsonl'),
      '{"t":"2026-04-15T12:00:00Z","directive_id":"d1","source_fingerprint":"fp","session_id":"s1","command_preview":"cmd"}\n' +
        'not-json\n' +
        '{"missing":"fields"}\n',
    );

    const result = readPreventedErrors(stateDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.directive_id).toBe('d1');
  });

  it('does nothing when appending empty array', () => {
    appendPreventedErrors(stateDir, []);
    expect(existsSync(join(stateDir, 'error-prevention.jsonl'))).toBe(false);
  });

  it('appends to existing file', () => {
    const batch1: PreventedError[] = [
      {
        t: '2026-04-15T12:00:00Z',
        directive_id: 'dir-1',
        source_fingerprint: 'npm test',
        session_id: 'sess-1',
        command_preview: 'npm test',
      },
    ];
    const batch2: PreventedError[] = [
      {
        t: '2026-04-15T13:00:00Z',
        directive_id: 'dir-2',
        source_fingerprint: 'npm run build',
        session_id: 'sess-2',
        command_preview: 'npm run build',
      },
    ];

    appendPreventedErrors(stateDir, batch1);
    appendPreventedErrors(stateDir, batch2);

    const result = readPreventedErrors(stateDir);
    expect(result).toHaveLength(2);
  });
});

// ─── Compaction Tests ────────────────────────────────────

describe('compactPreventedErrors', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('removes entries older than maxAgeDays', () => {
    mkdirSync(stateDir, { recursive: true });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date().toISOString();

    writeFileSync(
      join(stateDir, 'error-prevention.jsonl'),
      JSON.stringify({
        t: oldDate,
        directive_id: 'd1',
        source_fingerprint: 'fp',
        session_id: 's1',
        command_preview: 'cmd',
      }) +
        '\n' +
        JSON.stringify({
          t: recentDate,
          directive_id: 'd2',
          source_fingerprint: 'fp2',
          session_id: 's2',
          command_preview: 'cmd2',
        }) +
        '\n',
    );

    const removed = compactPreventedErrors(stateDir, 90);
    expect(removed).toBe(1);

    const remaining = readPreventedErrors(stateDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.directive_id).toBe('d2');
  });

  it('returns 0 for missing file', () => {
    expect(compactPreventedErrors(stateDir, 90)).toBe(0);
  });

  it('returns 0 for empty file', () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'error-prevention.jsonl'), '');
    expect(compactPreventedErrors(stateDir, 90)).toBe(0);
  });

  it('keeps all entries when none are expired', () => {
    const recentDate = new Date().toISOString();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'error-prevention.jsonl'),
      JSON.stringify({
        t: recentDate,
        directive_id: 'd1',
        source_fingerprint: 'fp',
        session_id: 's1',
        command_preview: 'cmd',
      }) + '\n',
    );

    const removed = compactPreventedErrors(stateDir, 90);
    expect(removed).toBe(0);

    const remaining = readPreventedErrors(stateDir);
    expect(remaining).toHaveLength(1);
  });
});
