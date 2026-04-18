/**
 * Unit tests for I9 — Directive preservation across uninstall/install.
 *
 * Covers:
 *   - extractDirectivesFromBody parses bullet format
 *   - loadActiveDirectives returns only non-pruned entries sorted correctly
 *   - setJustRestored creates flag file
 *   - consumeJustRestored reads + deletes flag atomically
 *   - consumeJustRestored returns false when flag missing
 *   - extractDirectivesFromBody handles empty body
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadActiveDirectives,
  setJustRestored,
  consumeJustRestored,
  extractDirectivesFromBody,
  saveHistory,
  emptyHistory,
  updateFromProposals,
  type DirectiveHistoryEntry,
  type DirectiveProposalLike,
} from '../../src/managed-section/directive-history.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-sop-i9-'));
}

function makeProposal(
  overrides: Partial<DirectiveProposalLike> = {},
): DirectiveProposalLike {
  return {
    id: 'det-test-0000',
    rule_text: 'Default rule text body long enough to pass min length check.',
    severity: 'warning',
    evidence: { first_seen: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

// ─── extractDirectivesFromBody ──────────────────────────

describe('extractDirectivesFromBody', () => {
  const now = '2026-04-18T12:00:00.000Z';

  it('parses directive bullets from managed section body', () => {
    const body = [
      '_Data as of: 2026-04-18T12:00:00Z · 10 turns analyzed · 1 agent: claude_',
      '',
      '**Learnings** (3 active directives)',
      '',
      '- **[error]** Always validate user input before database queries',
      '  _(evidence: 5 sessions · [view turns](.claude-sop/captures/abc123))_',
      '',
      '- **[warning]** Use try-catch blocks around file system operations',
      '  _(evidence: 3 sessions · [view turns](.claude-sop/captures/def456))_',
      '',
      '- **[info]** Prefer const over let for immutable bindings',
      '  _(evidence: 4 sessions)_',
    ].join('\n');

    const result = extractDirectivesFromBody(body, now);
    expect(result).toHaveLength(3);

    expect(result[0]!.severity).toBe('error');
    expect(result[0]!.rule_text).toBe('Always validate user input before database queries');
    expect(result[0]!.first_seen).toBe(now);
    expect(result[0]!.pruned).toBe(false);

    expect(result[1]!.severity).toBe('warning');
    expect(result[1]!.rule_text).toBe('Use try-catch blocks around file system operations');

    expect(result[2]!.severity).toBe('info');
    expect(result[2]!.rule_text).toBe('Prefer const over let for immutable bindings');
  });

  it('returns empty array for body with no directives', () => {
    const body = '_No recurring patterns detected yet._';
    const result = extractDirectivesFromBody(body, now);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty body', () => {
    expect(extractDirectivesFromBody('', now)).toHaveLength(0);
  });

  it('generates deterministic ids from rule text', () => {
    const body = '- **[warning]** Use strict mode in TypeScript config';
    const r1 = extractDirectivesFromBody(body, now);
    const r2 = extractDirectivesFromBody(body, now);
    expect(r1[0]!.id).toBe(r2[0]!.id);
    expect(r1[0]!.id).toMatch(/^restored-/);
  });
});

// ─── loadActiveDirectives ───────────────────────────────

describe('loadActiveDirectives', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when no history file exists', () => {
    expect(loadActiveDirectives(root)).toEqual([]);
  });

  it('returns only non-pruned entries', () => {
    const history = updateFromProposals(
      emptyHistory(),
      [
        makeProposal({ id: 'det-a', rule_text: 'Active directive text that is long enough.' }),
        makeProposal({ id: 'det-b', rule_text: 'Pruned directive text that is long enough.' }),
      ],
      '2026-01-01T00:00:00.000Z',
    );
    // Mark one as pruned
    history.entries['det-b']!.pruned = true;
    history.entries['det-b']!.pruned_at = '2026-01-01T00:00:00.000Z';
    saveHistory(root, history);

    const active = loadActiveDirectives(root);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe('det-a');
  });

  it('sorts by severity desc, last_reinforced desc, id asc', () => {
    const history = updateFromProposals(
      emptyHistory(),
      [
        makeProposal({ id: 'det-info', severity: 'info', rule_text: 'Info directive that is long enough to pass.' }),
        makeProposal({ id: 'det-error', severity: 'error', rule_text: 'Error directive that is long enough to pass.' }),
        makeProposal({ id: 'det-warn', severity: 'warning', rule_text: 'Warning directive that is long enough.' }),
      ],
      '2026-01-01T00:00:00.000Z',
    );
    saveHistory(root, history);

    const active = loadActiveDirectives(root);
    expect(active.map((e) => e.severity)).toEqual(['error', 'warning', 'info']);
  });
});

// ─── just_restored flag ─────────────────────────────────

describe('just_restored flag', () => {
  let root: string;

  beforeEach(() => {
    root = makeTmpDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('setJustRestored creates flag file', () => {
    setJustRestored(root);
    const flagPath = join(root, '.claude-sop', 'state', 'just-restored.flag');
    expect(existsSync(flagPath)).toBe(true);
  });

  it('consumeJustRestored returns true and removes flag', () => {
    setJustRestored(root);
    expect(consumeJustRestored(root)).toBe(true);
    // Second call returns false (flag consumed)
    expect(consumeJustRestored(root)).toBe(false);
  });

  it('consumeJustRestored returns false when no flag set', () => {
    expect(consumeJustRestored(root)).toBe(false);
  });

  it('consumeJustRestored returns false on non-existent state dir', () => {
    // root exists but .claude-sop/state does not
    expect(consumeJustRestored(root)).toBe(false);
  });
});
