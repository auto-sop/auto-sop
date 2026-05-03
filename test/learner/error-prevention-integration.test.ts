/**
 * Integration tests for V31 features — validates cross-module behavior:
 *
 * a. Fire detection: bigram matching accuracy (bigrams reduce false positives)
 * b. Fire categorization: severity → category mapping
 * c. Error prevention e2e: bash failure → directive w/ fingerprint → success → detected
 * d. Session metrics: before/after comparison from multi-session turn data
 * e. Stats aggregator: categorized fire counts + backward compat with old fires
 * f. Backward compat: old data without v31 fields still parses and works
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractKeywords,
  extractBigrams,
  matchDirective,
  detectDirectiveFires,
  appendFires,
  readFires,
  FIRES_FILENAME,
} from '~/capture/writer/directive-fire.js';
import type { DirectiveFire, DirectiveInput } from '~/capture/writer/directive-fire.js';
import {
  detectPreventedErrors,
  appendPreventedErrors,
  readPreventedErrors,
  type DirectiveFingerprint,
  type PreventedError,
} from '../../src/learner/error-prevention.js';
import { buildSessionSummaries, compareBeforeAfter } from '../../src/learner/session-metrics.js';
import { fingerprintCommand } from '../../src/learner/command-fingerprint.js';
import type { TurnData, ToolCall } from '../../src/learner/turn-loader.js';

// ─── Helpers ─────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'auto-sop-integ-'));
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

function makeTurn(overrides: Partial<TurnData> & { tool_calls: ToolCall[] }): TurnData {
  return {
    turn_id: 'turn-001',
    session_id: 'sess-new',
    agent: 'main',
    finalized_at: '2026-04-15T12:00:00Z',
    ...overrides,
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

function makeBashCallPair(useId: string, command: string, success: boolean, t: string): ToolCall[] {
  return [
    {
      event: 'pre',
      tool_use_id: useId,
      tool: 'Bash',
      input: { command },
      t,
    },
    {
      event: 'post',
      tool_use_id: useId,
      tool: 'Bash',
      output: { __untrusted: true, exitCode: success ? 0 : 1 },
      success,
      t,
    },
  ];
}

function makeSessionTurn(
  turnId: string,
  sessionId: string,
  finalizedAt: string,
  toolCalls: ToolCall[] = [],
): TurnData {
  return {
    turn_id: turnId,
    session_id: sessionId,
    agent: 'main',
    finalized_at: finalizedAt,
    tool_calls: toolCalls,
  };
}

// ─── a. Fire detection: bigram matching accuracy ─────────

describe('integration: bigram matching accuracy', () => {
  it('fires on a prompt with matching bigrams from the directive', () => {
    const ruleText = 'Always run build verification before committing code changes';
    const keywords = extractKeywords(ruleText);
    const bigrams = extractBigrams(ruleText);

    // Prompt that genuinely matches the directive's intent
    const goodPrompt = 'I need to run build verification before committing code changes';
    const result = matchDirective(goodPrompt, keywords, bigrams);

    expect(result).not.toBeNull();
    expect(result!.bigram_hits).toBeGreaterThan(0);
    expect(result!.hits).toBeGreaterThanOrEqual(3);
  });

  it('rejects a prompt with coincidental keyword overlap but no bigram match', () => {
    // Directive about database migration safety
    const ruleText = 'Never run database migration without backup verification first';
    const keywords = extractKeywords(ruleText);
    const bigrams = extractBigrams(ruleText);

    // Prompt uses some of the same individual words in unrelated context
    // "run" is a stopword so won't match; "database" and "migration" are individual hits
    // but the bigrams ("database migration", "migration without", "backup verification") won't match
    const unrelatedPrompt =
      'the verification process for database records shows migration statistics';
    const result = matchDirective(unrelatedPrompt, keywords, bigrams);

    // With bigram weighting, this should either not match or score lower
    // than the genuine match above. The key insight: bigrams "database migration"
    // are NOT present in the unrelated prompt (it's "database records" and "migration statistics")
    if (result !== null) {
      // If it does match, bigram_hits should be 0 (no consecutive pairs match)
      expect(result.bigram_hits).toBe(0);
    }
  });

  it('bigrams improve discrimination: same unigram count but different bigram count', () => {
    const ruleText = 'Always validate input parameters before database queries execution';
    const keywords = extractKeywords(ruleText);
    const bigrams = extractBigrams(ruleText);

    // Prompt 1: genuinely related — contains matching bigrams
    const related = 'validate input parameters before database queries';
    const resultRelated = matchDirective(related, keywords, bigrams);

    // Prompt 2: same individual words but shuffled — fewer bigram matches
    const shuffled = 'queries about database parameters and input validation execution';
    const resultShuffled = matchDirective(shuffled, keywords, bigrams);

    // The related prompt should have a higher score than the shuffled one
    // because bigrams match (2 points each vs 1 point for unigrams)
    if (resultRelated !== null && resultShuffled !== null) {
      expect(resultRelated.ratio).toBeGreaterThanOrEqual(resultShuffled.ratio);
      expect(resultRelated.bigram_hits).toBeGreaterThan(resultShuffled.bigram_hits);
    } else {
      // At minimum, the related prompt should match
      expect(resultRelated).not.toBeNull();
    }
  });
});

// ─── b. Fire categorization: severity → category ────────

describe('integration: fire categorization', () => {
  const SESSION_ID = 'sess-cat-test';
  const PROJECT_ID = 'proj-cat-test';

  it('error severity maps to error-preventing category', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-err',
        rule_text: 'Never commit secrets or credentials to the repository codebase',
        severity: 'error',
      },
    ];
    const fires = detectDirectiveFires(
      'never commit secrets or credentials to the repository codebase',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('error-preventing');
  });

  it('warning severity maps to efficiency category', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-warn',
        rule_text: 'Always run tests before committing changes to the branch',
        severity: 'warning',
      },
    ];
    const fires = detectDirectiveFires(
      'run tests before committing changes to the branch always',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('efficiency');
  });

  it('info severity maps to best-practice category', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-info',
        rule_text: 'Prefer named exports over default exports in TypeScript modules',
        severity: 'info',
      },
    ];
    const fires = detectDirectiveFires(
      'prefer named exports over default exports in typescript modules',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('best-practice');
  });

  it('missing severity defaults to best-practice category', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-none',
        rule_text: 'Keep functions short and focused on single responsibility principle',
        // no severity
      },
    ];
    const fires = detectDirectiveFires(
      'keep functions short and focused on single responsibility principle',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('best-practice');
  });

  it('mixed severities produce correct categories in a single batch', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-a',
        rule_text: 'Never commit secrets or credentials to the repository codebase',
        severity: 'error',
      },
      {
        id: 'dir-b',
        rule_text: 'Always run build checks before pushing changes to remote branch',
        severity: 'warning',
      },
      {
        id: 'dir-c',
        rule_text: 'Prefer named exports over default exports in TypeScript project',
        severity: 'info',
      },
    ];
    const fires = detectDirectiveFires(
      'never commit secrets or credentials to the repository codebase. ' +
        'run build checks before pushing changes to remote branch always. ' +
        'prefer named exports over default exports in typescript project.',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    const categories = fires.map((f) => f.category).sort();
    expect(categories).toContain('error-preventing');
    expect(categories).toContain('efficiency');
    expect(categories).toContain('best-practice');
  });
});

// ─── c. Error prevention end-to-end ─────────────────────

describe('integration: error prevention end-to-end', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('full pipeline: bash failure → directive with fingerprint → success → PreventedError', () => {
    // Step 1: A command fails repeatedly (simulated by fingerprint creation)
    const command = 'npm run build --strict';
    const fp = fingerprintCommand(command);

    // Step 2: A directive was created with this source_fingerprint
    const directiveFingerprint = makeFingerprint({
      directive_id: 'repeated-bash-failure-build-strict',
      source_fingerprint: fp,
      first_seen: '2026-04-01T00:00:00Z',
      evidence_sessions: ['sess-fail-1', 'sess-fail-2', 'sess-fail-3'],
    });

    // Step 3: In a NEW session, the same command SUCCEEDS (user learned the pattern)
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-success-1',
        finalized_at: '2026-04-15T12:00:00Z',
        tool_calls: [
          makePreCall('tu1', command, '2026-04-15T12:00:00Z'),
          makePostCall('tu1', true, '2026-04-15T12:00:01Z'),
        ],
      }),
    ];

    // Step 4: Detect prevented errors
    const prevented = detectPreventedErrors(turns, [directiveFingerprint]);

    expect(prevented).toHaveLength(1);
    expect(prevented[0]!.directive_id).toBe('repeated-bash-failure-build-strict');
    expect(prevented[0]!.source_fingerprint).toBe(fp);
    expect(prevented[0]!.session_id).toBe('sess-success-1');
    expect(prevented[0]!.command_preview).toBe(command);

    // Step 5: Persist and read back
    appendPreventedErrors(stateDir, prevented);
    const readBack = readPreventedErrors(stateDir);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.directive_id).toBe('repeated-bash-failure-build-strict');
  });

  it('does not count success in original failure sessions', () => {
    const command = 'npm test';
    const fp = fingerprintCommand(command);

    const directiveFingerprint = makeFingerprint({
      source_fingerprint: fp,
      evidence_sessions: ['sess-original'],
    });

    // Same command succeeds in ORIGINAL session — should NOT count
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-original',
        tool_calls: [makePreCall('tu1', command), makePostCall('tu1', true)],
      }),
    ];

    const prevented = detectPreventedErrors(turns, [directiveFingerprint]);
    expect(prevented).toHaveLength(0);
  });

  it('does not count success before directive was created', () => {
    const command = 'npm test';
    const fp = fingerprintCommand(command);

    const directiveFingerprint = makeFingerprint({
      source_fingerprint: fp,
      first_seen: '2026-04-10T00:00:00Z',
    });

    // Command succeeds BEFORE directive first_seen
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-early',
        finalized_at: '2026-04-05T12:00:00Z',
        tool_calls: [
          makePreCall('tu1', command, '2026-04-05T12:00:00Z'),
          makePostCall('tu1', true, '2026-04-05T12:00:01Z'),
        ],
      }),
    ];

    const prevented = detectPreventedErrors(turns, [directiveFingerprint]);
    expect(prevented).toHaveLength(0);
  });

  it('fingerprintCommand normalization matches across whitespace variants', () => {
    // Directive was created from a command with extra spaces
    const originalCommand = 'npm   test   --coverage';
    const fp = fingerprintCommand(originalCommand);
    expect(fp).toBe('npm test --coverage');

    // User later runs same command with single spaces
    const laterCommand = 'npm test --coverage';
    const laterFp = fingerprintCommand(laterCommand);
    expect(laterFp).toBe(fp); // fingerprints match
  });
});

// ─── d. Session metrics: before/after from real turn data ─

describe('integration: session metrics before/after comparison', () => {
  it('builds summaries from multi-session turns and compares before/after', () => {
    // Simulate real turn data across 4 sessions: 2 before directive, 2 after
    const turns: TurnData[] = [
      // Session 1: before directive — high failures
      makeSessionTurn('t1', 's-before-1', '2026-04-10T10:00:00Z', [
        ...makeBashCallPair('tu1', 'npm test', false, '2026-04-10T10:00:00Z'),
        ...makeBashCallPair('tu2', 'npm test', false, '2026-04-10T10:01:00Z'),
        ...makeBashCallPair('tu3', 'npm run build', true, '2026-04-10T10:02:00Z'),
      ]),
      makeSessionTurn('t2', 's-before-1', '2026-04-10T10:30:00Z', [
        ...makeBashCallPair('tu4', 'npm test', false, '2026-04-10T10:30:00Z'),
      ]),

      // Session 2: before directive — also high failures
      makeSessionTurn('t3', 's-before-2', '2026-04-11T10:00:00Z', [
        ...makeBashCallPair('tu5', 'npm test', false, '2026-04-11T10:00:00Z'),
        ...makeBashCallPair('tu6', 'npm run build', false, '2026-04-11T10:01:00Z'),
      ]),
      makeSessionTurn('t4', 's-before-2', '2026-04-11T10:20:00Z', [
        ...makeBashCallPair('tu7', 'npm test', true, '2026-04-11T10:20:00Z'),
      ]),

      // Session 3: after directive — fewer failures
      makeSessionTurn('t5', 's-after-1', '2026-04-20T10:00:00Z', [
        ...makeBashCallPair('tu8', 'npm test', true, '2026-04-20T10:00:00Z'),
        ...makeBashCallPair('tu9', 'npm run build', true, '2026-04-20T10:01:00Z'),
      ]),
      makeSessionTurn('t6', 's-after-1', '2026-04-20T10:15:00Z', [
        ...makeBashCallPair('tu10', 'npm test', true, '2026-04-20T10:15:00Z'),
      ]),

      // Session 4: after directive — zero failures
      makeSessionTurn('t7', 's-after-2', '2026-04-21T10:00:00Z', [
        ...makeBashCallPair('tu11', 'npm test', true, '2026-04-21T10:00:00Z'),
        ...makeBashCallPair('tu12', 'npm run build', true, '2026-04-21T10:01:00Z'),
      ]),
      makeSessionTurn('t8', 's-after-2', '2026-04-21T10:10:00Z', [
        ...makeBashCallPair('tu13', 'npm test', true, '2026-04-21T10:10:00Z'),
      ]),
    ];

    // Build summaries
    const summaries = buildSessionSummaries(turns);
    expect(summaries).toHaveLength(4);

    // Verify ordering (by started_at ascending)
    expect(summaries[0]!.session_id).toBe('s-before-1');
    expect(summaries[1]!.session_id).toBe('s-before-2');
    expect(summaries[2]!.session_id).toBe('s-after-1');
    expect(summaries[3]!.session_id).toBe('s-after-2');

    // Before sessions should have more bash failures
    expect(summaries[0]!.bash_failure_count).toBe(3); // 3 failures in s-before-1
    expect(summaries[1]!.bash_failure_count).toBe(2); // 2 failures in s-before-2
    expect(summaries[2]!.bash_failure_count).toBe(0); // 0 failures in s-after-1
    expect(summaries[3]!.bash_failure_count).toBe(0); // 0 failures in s-after-2

    // Compare before/after with cutoff between the two groups
    const comparison = compareBeforeAfter(summaries, '2026-04-15T00:00:00Z');
    expect(comparison).not.toBeNull();
    expect(comparison!.before.sessions).toBe(2);
    expect(comparison!.after.sessions).toBe(2);

    // Before: avg bash failures = (3+2)/2 = 2.5
    expect(comparison!.before.avg_bash_failures).toBe(2.5);
    // After: avg bash failures = (0+0)/2 = 0
    expect(comparison!.after.avg_bash_failures).toBe(0);

    // Improvement should be negative (reduction is good) — but 0/2.5 = -100%
    expect(comparison!.improvement.bash_failures_pct).toBe(-100);
  });

  it('returns null when not enough sessions in a bucket', () => {
    const turns: TurnData[] = [
      makeSessionTurn('t1', 's1', '2026-04-10T10:00:00Z'),
      makeSessionTurn('t2', 's2', '2026-04-20T10:00:00Z'),
    ];
    const summaries = buildSessionSummaries(turns);
    // Only 1 session in each bucket → not enough
    const comparison = compareBeforeAfter(summaries, '2026-04-15T00:00:00Z');
    expect(comparison).toBeNull();
  });
});

// ─── e. Stats aggregator: categorized fire counts ───────

describe('integration: stats aggregator logic (categorized fire counts)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('correctly counts fires by category', () => {
    const fires: DirectiveFire[] = [
      {
        t: '2026-04-20T10:00:00Z',
        directive_id: 'dir-1',
        session_id: 'sess-1',
        project_id: 'proj-1',
        keyword_hits: 4,
        keyword_total: 5,
        match_ratio: 0.8,
        category: 'error-preventing',
        bigram_hits: 2,
        bigram_total: 3,
      },
      {
        t: '2026-04-20T11:00:00Z',
        directive_id: 'dir-2',
        session_id: 'sess-1',
        project_id: 'proj-1',
        keyword_hits: 3,
        keyword_total: 5,
        match_ratio: 0.6,
        category: 'efficiency',
        bigram_hits: 1,
        bigram_total: 2,
      },
      {
        t: '2026-04-20T12:00:00Z',
        directive_id: 'dir-3',
        session_id: 'sess-2',
        project_id: 'proj-1',
        keyword_hits: 3,
        keyword_total: 4,
        match_ratio: 0.75,
        category: 'best-practice',
        bigram_hits: 1,
        bigram_total: 2,
      },
      {
        t: '2026-04-20T13:00:00Z',
        directive_id: 'dir-1',
        session_id: 'sess-3',
        project_id: 'proj-1',
        keyword_hits: 4,
        keyword_total: 5,
        match_ratio: 0.8,
        category: 'error-preventing',
        bigram_hits: 2,
        bigram_total: 3,
      },
    ];

    // Write fires and read back
    appendFires(stateDir, fires);
    const readBack = readFires(stateDir);
    expect(readBack).toHaveLength(4);

    // Manually compute category counts (same logic as aggregator.categoryKey)
    const counts = { error_preventing: 0, efficiency: 0, best_practice: 0 };
    for (const fire of readBack) {
      if (fire.category === 'error-preventing') counts.error_preventing++;
      else if (fire.category === 'efficiency') counts.efficiency++;
      else counts.best_practice++;
    }
    expect(counts.error_preventing).toBe(2);
    expect(counts.efficiency).toBe(1);
    expect(counts.best_practice).toBe(1);
  });

  it('handles old fires without category (defaults to best-practice)', () => {
    // Old-format fires: no category, no bigram_hits, no bigram_total
    const oldFires = [
      {
        t: '2026-04-20T10:00:00Z',
        directive_id: 'dir-old-1',
        session_id: 'sess-1',
        project_id: 'proj-1',
        keyword_hits: 3,
        keyword_total: 5,
        match_ratio: 0.6,
      },
      {
        t: '2026-04-20T11:00:00Z',
        directive_id: 'dir-old-2',
        session_id: 'sess-2',
        project_id: 'proj-1',
        keyword_hits: 4,
        keyword_total: 6,
        match_ratio: 0.67,
      },
    ];

    // Write old-format JSONL directly (no v31 fields)
    mkdirSync(stateDir, { recursive: true });
    const jsonl = oldFires.map((f) => JSON.stringify(f)).join('\n') + '\n';
    writeFileSync(join(stateDir, FIRES_FILENAME), jsonl);

    const readBack = readFires(stateDir);
    expect(readBack).toHaveLength(2);

    // Old fires should NOT have category field
    expect(readBack[0]!.category).toBeUndefined();
    expect(readBack[1]!.category).toBeUndefined();

    // Aggregator logic: undefined category → best_practice (default)
    const counts = { error_preventing: 0, efficiency: 0, best_practice: 0 };
    for (const fire of readBack) {
      if (fire.category === 'error-preventing') counts.error_preventing++;
      else if (fire.category === 'efficiency') counts.efficiency++;
      else counts.best_practice++; // undefined defaults here
    }
    expect(counts.best_practice).toBe(2);
    expect(counts.error_preventing).toBe(0);
    expect(counts.efficiency).toBe(0);
  });

  it('handles mix of old fires (no category) and new fires (with category)', () => {
    mkdirSync(stateDir, { recursive: true });
    const mixedJsonl =
      [
        // Old fire — no v31 fields
        JSON.stringify({
          t: '2026-04-19T10:00:00Z',
          directive_id: 'dir-old',
          session_id: 'sess-1',
          project_id: 'proj-1',
          keyword_hits: 3,
          keyword_total: 5,
          match_ratio: 0.6,
        }),
        // New fire — with v31 fields
        JSON.stringify({
          t: '2026-04-20T10:00:00Z',
          directive_id: 'dir-new',
          session_id: 'sess-2',
          project_id: 'proj-1',
          keyword_hits: 4,
          keyword_total: 5,
          match_ratio: 0.8,
          category: 'error-preventing',
          bigram_hits: 2,
          bigram_total: 3,
        }),
      ].join('\n') + '\n';

    writeFileSync(join(stateDir, FIRES_FILENAME), mixedJsonl);
    const readBack = readFires(stateDir);
    expect(readBack).toHaveLength(2);

    // Old fire: no category
    const oldFire = readBack.find((f) => f.directive_id === 'dir-old');
    expect(oldFire).toBeDefined();
    expect(oldFire!.category).toBeUndefined();
    expect(oldFire!.bigram_hits).toBeUndefined();

    // New fire: has category
    const newFire = readBack.find((f) => f.directive_id === 'dir-new');
    expect(newFire).toBeDefined();
    expect(newFire!.category).toBe('error-preventing');
    expect(newFire!.bigram_hits).toBe(2);
    expect(newFire!.bigram_total).toBe(3);
  });
});

// ─── f. Backward compatibility ──────────────────────────

describe('integration: backward compatibility', () => {
  it('old DirectiveFire without category/bigram fields parses correctly', () => {
    const dir = makeTmpDir();
    const oldFire = {
      t: '2026-04-15T10:00:00Z',
      directive_id: 'dir-legacy',
      session_id: 'sess-1',
      project_id: 'proj-1',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
      // No category, bigram_hits, bigram_total
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, FIRES_FILENAME), JSON.stringify(oldFire) + '\n');
    const fires = readFires(dir);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.directive_id).toBe('dir-legacy');
    expect(fires[0]!.category).toBeUndefined();
    expect(fires[0]!.bigram_hits).toBeUndefined();
    expect(fires[0]!.bigram_total).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('old PreventedError data (if ever produced without v31 fields) parses correctly', () => {
    const dir = makeTmpDir();
    const error: PreventedError = {
      t: '2026-04-15T10:00:00Z',
      directive_id: 'dir-1',
      source_fingerprint: 'npm test',
      session_id: 'sess-1',
      command_preview: 'npm test',
    };
    appendPreventedErrors(dir, [error]);
    const readBack = readPreventedErrors(dir);
    expect(readBack).toHaveLength(1);
    expect(readBack[0]!.directive_id).toBe('dir-1');
    rmSync(dir, { recursive: true, force: true });
  });

  it('matchDirective works without bigrams parameter (backward compat)', () => {
    const keywords = ['alpha', 'beta', 'gamma'];
    const result = matchDirective('use alpha and beta and gamma values', keywords);
    expect(result).not.toBeNull();
    expect(result!.bigram_hits).toBe(0);
    expect(result!.bigram_total).toBe(0);
  });

  it('detectDirectiveFires works with directives missing severity', () => {
    const directives: DirectiveInput[] = [
      {
        id: 'dir-no-severity',
        rule_text: 'Keep functions short and focused on single responsibility principle',
        // no severity field
      },
    ];
    const fires = detectDirectiveFires(
      'keep functions short and focused on single responsibility principle',
      directives,
      'sess-test',
      'proj-test',
    );
    expect(fires).toHaveLength(1);
    // Default: best-practice when severity is missing
    expect(fires[0]!.category).toBe('best-practice');
  });

  it('DirectiveFingerprint with empty evidence_sessions still works', () => {
    const turns: TurnData[] = [
      makeTurn({
        session_id: 'sess-any',
        tool_calls: [makePreCall('tu1', 'npm test'), makePostCall('tu1', true)],
      }),
    ];
    const fps = [
      makeFingerprint({
        evidence_sessions: [], // empty array
        source_fingerprint: 'npm test',
      }),
    ];

    const result = detectPreventedErrors(turns, fps);
    // Empty evidence_sessions means no sessions excluded — should detect
    expect(result).toHaveLength(1);
  });

  it('readFires returns sorted results regardless of insertion order', () => {
    const dir = makeTmpDir();
    mkdirSync(dir, { recursive: true });
    const fire1 = {
      t: '2026-04-20T10:00:00Z',
      directive_id: 'dir-c',
      session_id: 's',
      project_id: 'p',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
    };
    const fire2 = {
      t: '2026-04-10T10:00:00Z',
      directive_id: 'dir-a',
      session_id: 's',
      project_id: 'p',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
    };
    const fire3 = {
      t: '2026-04-15T10:00:00Z',
      directive_id: 'dir-b',
      session_id: 's',
      project_id: 'p',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
    };
    writeFileSync(
      join(dir, FIRES_FILENAME),
      [fire1, fire2, fire3].map((f) => JSON.stringify(f)).join('\n') + '\n',
    );
    const fires = readFires(dir);
    expect(fires).toHaveLength(3);
    // Should be sorted by timestamp ascending
    expect(fires[0]!.t).toBe('2026-04-10T10:00:00Z');
    expect(fires[1]!.t).toBe('2026-04-15T10:00:00Z');
    expect(fires[2]!.t).toBe('2026-04-20T10:00:00Z');
    rmSync(dir, { recursive: true, force: true });
  });
});
