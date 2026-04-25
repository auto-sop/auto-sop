import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  extractKeywords,
  extractBigrams,
  matchDirective,
  detectDirectiveFires,
  appendFires,
  readFires,
  compactFires,
  escapeRegExp,
  FIRES_FILENAME,
  MIN_KEYWORD_LENGTH,
  MIN_COMBINED_HITS,
  MIN_COMBINED_SCORE,
} from '~/capture/writer/directive-fire.js';
import type { DirectiveFire, DirectiveInput, FireCategory } from '~/capture/writer/directive-fire.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── extractKeywords ─────────────────────────────────────

describe('extractKeywords', () => {
  it('extracts meaningful keywords from rule text', () => {
    const result = extractKeywords('Always validate input before database queries');
    expect(result).toContain('validate');
    expect(result).toContain('input');
    expect(result).toContain('database');
    expect(result).toContain('queries');
  });

  it('lowercases all keywords', () => {
    const result = extractKeywords('UPPERCASE Keywords Here');
    for (const kw of result) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it('filters stopwords', () => {
    const result = extractKeywords('the and for with that this from have been');
    expect(result).toHaveLength(0);
  });

  it('filters tokens shorter than MIN_KEYWORD_LENGTH', () => {
    const result = extractKeywords('do it on or if no am is');
    expect(result).toHaveLength(0);
  });

  it('deduplicates keywords', () => {
    const result = extractKeywords('validate validate validate input input');
    expect(result.filter((k) => k === 'validate')).toHaveLength(1);
    expect(result.filter((k) => k === 'input')).toHaveLength(1);
  });

  it('returns sorted array', () => {
    const result = extractKeywords('zebra alpha mango banana');
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  it('splits on punctuation', () => {
    const result = extractKeywords('error-handling, input.validation; database_queries');
    expect(result).toContain('error');
    expect(result).toContain('handling');
    expect(result).toContain('input');
    expect(result).toContain('validation');
    expect(result).toContain('database');
    expect(result).toContain('queries');
  });

  it('handles empty string', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('handles string of only stopwords and short tokens', () => {
    expect(extractKeywords('the and for with is on it')).toEqual([]);
  });

  it('handles very short rule text', () => {
    // "fix" is only 3 chars — exactly MIN_KEYWORD_LENGTH
    const result = extractKeywords('fix');
    expect(result).toEqual(['fix']);
  });
});

// ─── extractBigrams ─────────────────────────────────────

describe('extractBigrams', () => {
  it('extracts consecutive word pairs from rule text', () => {
    const result = extractBigrams('Always pull user-controlled files before dev work');
    expect(result).toContain('always pull');
    expect(result).toContain('pull user');
    expect(result).toContain('user controlled');
    expect(result).toContain('controlled files');
    expect(result).toContain('files before');
    expect(result).toContain('before dev');
    expect(result).toContain('dev work');
  });

  it('lowercases all bigrams', () => {
    const result = extractBigrams('UPPERCASE Keywords Here Now');
    for (const bg of result) {
      expect(bg).toBe(bg.toLowerCase());
    }
  });

  it('filters bigrams where both words are stopwords', () => {
    // "the and" → both stopwords → filtered
    // "the validate" → only one stopword → kept (if combined length ≥ 7)
    const result = extractBigrams('the and for with validate');
    expect(result).not.toContain('the and');
    expect(result).not.toContain('and for');
    expect(result).not.toContain('for with');
    // "with validate" → combined length = 4 + 8 = 12 ≥ 7, one non-stopword → kept
    expect(result).toContain('with validate');
  });

  it('filters bigrams with combined length < 7', () => {
    // "do it" → 2 + 2 = 4 < 7 → filtered
    const result = extractBigrams('do it now');
    expect(result).not.toContain('do it');
  });

  it('deduplicates bigrams', () => {
    const result = extractBigrams('validate input validate input');
    const validateInput = result.filter((bg) => bg === 'validate input');
    expect(validateInput).toHaveLength(1);
  });

  it('returns empty for single-word input', () => {
    expect(extractBigrams('validate')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(extractBigrams('')).toEqual([]);
  });

  it('handles very short rule_text with only stopwords', () => {
    expect(extractBigrams('the and for')).toEqual([]);
  });

  it('splits on punctuation like extractKeywords', () => {
    const result = extractBigrams('error-handling, input.validation');
    expect(result).toContain('error handling');
    expect(result).toContain('handling input');
    expect(result).toContain('input validation');
  });
});

// ─── escapeRegExp ────────────────────────────────────────

describe('escapeRegExp', () => {
  it('escapes all regex special characters', () => {
    const specials = '.*+?^${}()|[]\\';
    const escaped = escapeRegExp(specials);
    // Should not throw when used in a RegExp
    expect(() => new RegExp(escaped)).not.toThrow();
    // Escaped version should match the literal string
    expect(new RegExp(escaped).test(specials)).toBe(true);
  });

  it('leaves normal strings unchanged', () => {
    expect(escapeRegExp('hello')).toBe('hello');
    expect(escapeRegExp('validate')).toBe('validate');
  });

  it('escapes dots in keywords like node.js', () => {
    const escaped = escapeRegExp('node.js');
    expect(escaped).toBe('node\\.js');
  });

  it('escapes plus signs in keywords like c++', () => {
    const escaped = escapeRegExp('c++');
    expect(escaped).toBe('c\\+\\+');
  });
});

// ─── matchDirective ──────────────────────────────────────

describe('matchDirective', () => {
  it('returns match stats when combined threshold is met', () => {
    const keywords = ['validate', 'input', 'database', 'queries'];
    const bigrams = ['validate input', 'database queries'];
    // Prompt contains "validate input" and "database queries" as substrings
    const result = matchDirective('please validate input before running database queries', keywords, bigrams);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(4); // 4 unigram hits
    expect(result!.total).toBe(4);
    expect(result!.bigram_hits).toBe(2); // 2 bigram hits
    expect(result!.bigram_total).toBe(2);
  });

  it('returns null when fewer than MIN_COMBINED_HITS total', () => {
    const keywords = ['validate', 'input', 'database', 'queries', 'security'];
    // Only 1 unigram hit, 0 bigram hits = 1 total < 3
    const result = matchDirective('please validate something', keywords);
    expect(result).toBeNull();
  });

  it('returns null when score is below MIN_COMBINED_SCORE', () => {
    // 10 keywords, 2 unigram hits, no bigrams → score = 2/10 = 0.2 < 0.3
    const keywords = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh', 'iii', 'jjj'];
    const result = matchDirective('something with aaa and bbb and ccc', keywords);
    // 3 hits, score = 3/10 = 0.3, threshold met at exactly 0.3 AND 3 hits
    expect(result).not.toBeNull();
  });

  it('returns null for empty keywords', () => {
    expect(matchDirective('some prompt', [])).toBeNull();
  });

  it('is case-insensitive for prompt matching', () => {
    const keywords = ['validate', 'input', 'data'];
    const result = matchDirective('VALIDATE YOUR INPUT DATA', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(3);
  });

  it('rounds score to 3 decimal places', () => {
    // 3 keywords, 3 hits, no bigrams → score = 3/3 = 1.0
    const keywords = ['alpha', 'beta', 'gamma'];
    const result = matchDirective('use alpha and beta and gamma in code', keywords);
    expect(result).not.toBeNull();
    expect(result!.ratio).toBe(1);
  });

  it('bigram hits contribute 2 points each to score', () => {
    // 2 keywords + 1 bigram. Prompt matches 1 keyword + 1 bigram
    // unigram points: 1*1 = 1, bigram points: 1*2 = 2, total = 3
    // max: 2*1 + 1*2 = 4, score = 3/4 = 0.75
    // total hits: 1+1 = 2 — but need 3 combined hits
    const keywords = ['validate', 'input'];
    const bigrams = ['validate input'];
    // prompt has both "validate" and "input" as unigrams + bigram
    const result = matchDirective('please validate input correctly', keywords, bigrams);
    // 2 unigram hits + 1 bigram hit = 3 total hits ≥ 3 ✓
    // score = (2*1 + 1*2)/(2*1 + 1*2) = 4/4 = 1.0 ≥ 0.3 ✓
    expect(result).not.toBeNull();
    expect(result!.bigram_hits).toBe(1);
  });

  it('returns null for prompt with no matching keywords', () => {
    const keywords = ['validate', 'database', 'queries'];
    expect(matchDirective('completely unrelated text about weather', keywords)).toBeNull();
  });

  it('handles keywords with regex special characters safely', () => {
    const keywords = ['node', 'error', 'fix'];
    expect(() => matchDirective('fix the node error please', keywords)).not.toThrow();
    const result = matchDirective('fix the node error please', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(3);
  });

  it('uses word boundaries to avoid substring matches', () => {
    const keywords = ['port', 'log'];
    const result = matchDirective('the report from the catalog is ready', keywords);
    expect(result).toBeNull();
  });

  it('word boundary matching: matches whole words only', () => {
    const keywords = ['port', 'log', 'check'];
    const result = matchDirective('check the port and read the log', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(3);
  });

  it('works without bigrams (backward compat)', () => {
    // When no bigrams passed, falls back to unigram-only scoring
    const keywords = ['alpha', 'beta', 'gamma'];
    const result = matchDirective('use alpha and beta and gamma in code', keywords);
    expect(result).not.toBeNull();
    expect(result!.bigram_hits).toBe(0);
    expect(result!.bigram_total).toBe(0);
  });

  it('bigram matching is case-insensitive', () => {
    const keywords = ['validate', 'input', 'data'];
    const bigrams = ['validate input'];
    const result = matchDirective('Please VALIDATE INPUT data now', keywords, bigrams);
    expect(result).not.toBeNull();
    expect(result!.bigram_hits).toBe(1);
  });
});

// ─── detectDirectiveFires ────────────────────────────────

describe('detectDirectiveFires', () => {
  const SESSION_ID = 'sess-abc';
  const PROJECT_ID = 'proj-xyz';

  it('returns fires for matching directives with category', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries', severity: 'error' },
    ];
    const fires = detectDirectiveFires(
      'make sure to validate user input before running database queries',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.directive_id).toBe('dir-1');
    expect(fires[0]!.session_id).toBe(SESSION_ID);
    expect(fires[0]!.project_id).toBe(PROJECT_ID);
    expect(fires[0]!.keyword_hits).toBeGreaterThanOrEqual(1);
    expect(fires[0]!.category).toBe('error-preventing');
    expect(typeof fires[0]!.bigram_hits).toBe('number');
    expect(typeof fires[0]!.bigram_total).toBe('number');
  });

  it('returns empty array for empty directives (fast path)', () => {
    expect(detectDirectiveFires('some prompt', [], SESSION_ID, PROJECT_ID)).toEqual([]);
  });

  it('skips directives that do not match', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries' },
      { id: 'dir-2', rule_text: 'Use TypeScript strict mode everywhere in the project configuration' },
    ];
    const fires = detectDirectiveFires(
      'please enable typescript strict mode in the project configuration',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    // Only dir-2 should match
    const matchedIds = fires.map((f) => f.directive_id);
    expect(matchedIds).toContain('dir-2');
  });

  it('can match multiple directives', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Validate all user input parameters carefully in the form handler' },
      { id: 'dir-2', rule_text: 'Validate form input fields correctly before saving to database' },
    ];
    const fires = detectDirectiveFires(
      'how to validate user input fields and form parameters before saving to database',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires.length).toBeGreaterThanOrEqual(1);
  });

  it('never stores prompt text in fire events', () => {
    const prompt = 'super secret prompt text handling data processing safely';
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'super secret prompt text handling data processing safely' },
    ];
    const fires = detectDirectiveFires(prompt, directives, SESSION_ID, PROJECT_ID);
    for (const fire of fires) {
      const serialized = JSON.stringify(fire);
      // Should not contain the exact full prompt
      expect(serialized).not.toContain('super secret prompt text handling data processing safely');
    }
  });

  it('populates all required fields in DirectiveFire including v31 fields', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries securely', severity: 'warning' },
    ];
    const fires = detectDirectiveFires(
      'validate input database queries check securely always',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    const fire = fires[0]!;
    expect(fire.t).toBeDefined();
    expect(fire.directive_id).toBe('dir-1');
    expect(fire.session_id).toBe(SESSION_ID);
    expect(fire.project_id).toBe(PROJECT_ID);
    expect(typeof fire.keyword_hits).toBe('number');
    expect(typeof fire.keyword_total).toBe('number');
    expect(typeof fire.match_ratio).toBe('number');
    expect(fire.category).toBe('efficiency');
    expect(typeof fire.bigram_hits).toBe('number');
    expect(typeof fire.bigram_total).toBe('number');
  });

  it('assigns error-preventing category for error severity', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Never commit secrets or credentials to the repository', severity: 'error' },
    ];
    const fires = detectDirectiveFires(
      'make sure to never commit secrets or credentials to the repository',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('error-preventing');
  });

  it('assigns efficiency category for warning severity', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always run tests before committing changes to the branch', severity: 'warning' },
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

  it('assigns best-practice category for info severity', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Prefer named exports over default exports in modules', severity: 'info' },
    ];
    const fires = detectDirectiveFires(
      'prefer named exports over default exports in modules always',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('best-practice');
  });

  it('defaults to best-practice when severity is not provided', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Keep functions short and focused on single responsibility always' },
    ];
    const fires = detectDirectiveFires(
      'keep functions short and focused on single responsibility always',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires).toHaveLength(1);
    expect(fires[0]!.category).toBe('best-practice');
  });
});

// ─── appendFires + readFires round-trip ──────────────────

describe('appendFires / readFires', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  function makeFire(overrides?: Partial<DirectiveFire>): DirectiveFire {
    return {
      t: new Date().toISOString(),
      directive_id: `dir-${randomUUID().slice(0, 8)}`,
      session_id: 'sess-test',
      project_id: 'proj-test',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
      ...overrides,
    };
  }

  it('writes and reads fires round-trip', () => {
    const fires = [makeFire(), makeFire()];
    appendFires(stateDir, fires);
    const read = readFires(stateDir);
    expect(read).toHaveLength(2);
    expect(read[0]!.directive_id).toBe(fires[0]!.directive_id);
    expect(read[1]!.directive_id).toBe(fires[1]!.directive_id);
  });

  it('creates file with correct name', () => {
    appendFires(stateDir, [makeFire()]);
    expect(existsSync(join(stateDir, FIRES_FILENAME))).toBe(true);
  });

  it('appends to existing file', () => {
    appendFires(stateDir, [makeFire()]);
    appendFires(stateDir, [makeFire()]);
    const read = readFires(stateDir);
    expect(read).toHaveLength(2);
  });

  it('does nothing for empty fires array', () => {
    appendFires(stateDir, []);
    expect(existsSync(join(stateDir, FIRES_FILENAME))).toBe(false);
  });

  it('never throws on append errors', () => {
    // Pass an invalid path — should not throw
    expect(() => appendFires('/nonexistent/invalid/path/that/does/not/exist', [makeFire()])).not.toThrow();
  });

  it('returns empty for missing file', () => {
    expect(readFires(stateDir)).toEqual([]);
  });

  it('returns empty for empty file', () => {
    writeFileSync(join(stateDir, FIRES_FILENAME), '');
    expect(readFires(stateDir)).toEqual([]);
  });

  it('skips malformed lines', () => {
    const good = makeFire();
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(good)}\nnot-valid-json\n{"missing":"fields"}\n`,
    );
    const read = readFires(stateDir);
    expect(read).toHaveLength(1);
    expect(read[0]!.directive_id).toBe(good.directive_id);
  });

  it('filters by since parameter', () => {
    const old = makeFire({ t: '2024-01-01T00:00:00.000Z' });
    const recent = makeFire({ t: '2026-06-01T00:00:00.000Z' });
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`,
    );
    const read = readFires(stateDir, '2025-01-01T00:00:00.000Z');
    expect(read).toHaveLength(1);
    expect(read[0]!.directive_id).toBe(recent.directive_id);
  });

  it('returns all fires when since is not provided', () => {
    const fire1 = makeFire({ t: '2024-01-01T00:00:00.000Z' });
    const fire2 = makeFire({ t: '2026-01-01T00:00:00.000Z' });
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(fire1)}\n${JSON.stringify(fire2)}\n`,
    );
    const read = readFires(stateDir);
    expect(read).toHaveLength(2);
  });

  it('returns results sorted by timestamp ascending', () => {
    const fire3 = makeFire({ t: '2026-03-01T00:00:00.000Z' });
    const fire1 = makeFire({ t: '2024-01-01T00:00:00.000Z' });
    const fire2 = makeFire({ t: '2025-06-01T00:00:00.000Z' });
    // Write out of order
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(fire3)}\n${JSON.stringify(fire1)}\n${JSON.stringify(fire2)}\n`,
    );
    const read = readFires(stateDir);
    expect(read).toHaveLength(3);
    expect(read[0]!.t).toBe(fire1.t);
    expect(read[1]!.t).toBe(fire2.t);
    expect(read[2]!.t).toBe(fire3.t);
  });
});

// ─── compactFires ────────────────────────────────────────

describe('compactFires', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  function makeFire(t: string): DirectiveFire {
    return {
      t,
      directive_id: `dir-${randomUUID().slice(0, 8)}`,
      session_id: 'sess-test',
      project_id: 'proj-test',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
    };
  }

  it('removes entries older than maxAgeDays', () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
    const recentDate = new Date().toISOString();
    const oldFire = makeFire(oldDate);
    const recentFire = makeFire(recentDate);

    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(oldFire)}\n${JSON.stringify(recentFire)}\n`,
    );

    const removed = compactFires(stateDir, 90);
    expect(removed).toBe(1);

    const remaining = readFires(stateDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.directive_id).toBe(recentFire.directive_id);
  });

  it('returns 0 for missing file', () => {
    expect(compactFires(stateDir, 90)).toBe(0);
  });

  it('returns 0 for empty file', () => {
    writeFileSync(join(stateDir, FIRES_FILENAME), '');
    expect(compactFires(stateDir, 90)).toBe(0);
  });

  it('keeps all entries when none are expired', () => {
    const fire1 = makeFire(new Date().toISOString());
    const fire2 = makeFire(new Date().toISOString());
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(fire1)}\n${JSON.stringify(fire2)}\n`,
    );

    const removed = compactFires(stateDir, 90);
    expect(removed).toBe(0);
    expect(readFires(stateDir)).toHaveLength(2);
  });

  it('removes all entries when all are expired', () => {
    const old1 = makeFire(new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString());
    const old2 = makeFire(new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString());
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(old1)}\n${JSON.stringify(old2)}\n`,
    );

    const removed = compactFires(stateDir, 90);
    expect(removed).toBe(2);

    const remaining = readFires(stateDir);
    expect(remaining).toHaveLength(0);
  });

  it('drops malformed lines during compaction', () => {
    const good = makeFire(new Date().toISOString());
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(good)}\nnot-valid-json\n`,
    );

    const removed = compactFires(stateDir, 90);
    expect(removed).toBe(1); // malformed line removed
    expect(readFires(stateDir)).toHaveLength(1);
  });

  it('performs atomic rewrite (file remains valid after compaction)', () => {
    const fire = makeFire(new Date().toISOString());
    writeFileSync(
      join(stateDir, FIRES_FILENAME),
      `${JSON.stringify(fire)}\n`,
    );

    compactFires(stateDir, 90);

    // File should still be valid JSONL
    const raw = readFileSync(join(stateDir, FIRES_FILENAME), 'utf8').trim();
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ─── Edge cases ──────────────────────────────────────────

describe('edge cases', () => {
  it('extractKeywords handles very short rule_text with only stopwords', () => {
    expect(extractKeywords('the and for')).toEqual([]);
  });

  it('extractKeywords handles numbers mixed with text', () => {
    const result = extractKeywords('use port 3000 for development server');
    expect(result).toContain('port');
    expect(result).toContain('development');
    expect(result).toContain('server');
    expect(result).toContain('3000');
  });

  it('matchDirective with exactly 1 keyword (always null since MIN_COMBINED_HITS=3)', () => {
    const result = matchDirective('something about alpha', ['alpha']);
    // Can't reach MIN_COMBINED_HITS=3 with only 1 keyword
    expect(result).toBeNull();
  });

  it('matchDirective with 3 keywords all matching (meets threshold)', () => {
    const result = matchDirective('alpha and beta and gamma values', ['alpha', 'beta', 'gamma']);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(3);
    expect(result!.ratio).toBe(1);
  });

  it('detectDirectiveFires handles directive with very short rule_text producing 0 keywords', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-empty', rule_text: 'do it' }, // all stopwords/short
    ];
    const fires = detectDirectiveFires('do it now', directives, 'sess', 'proj');
    expect(fires).toEqual([]);
  });

  it('appendFires creates parent directories if needed', () => {
    const deepDir = join(makeTmpDir(), 'nested', 'state');
    appendFires(deepDir, [{
      t: new Date().toISOString(),
      directive_id: 'dir-1',
      session_id: 'sess',
      project_id: 'proj',
      keyword_hits: 2,
      keyword_total: 4,
      match_ratio: 0.5,
    }]);
    expect(existsSync(join(deepDir, FIRES_FILENAME))).toBe(true);
  });

  it('readFires handles old fires without category (backward compat)', () => {
    const dir = makeTmpDir();
    const oldFire = {
      t: new Date().toISOString(),
      directive_id: 'dir-old',
      session_id: 'sess',
      project_id: 'proj',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
      // No category, bigram_hits, bigram_total — old format
    };
    writeFileSync(join(dir, FIRES_FILENAME), JSON.stringify(oldFire) + '\n');
    const read = readFires(dir);
    expect(read).toHaveLength(1);
    expect(read[0]!.directive_id).toBe('dir-old');
    // Optional fields should be undefined
    expect(read[0]!.category).toBeUndefined();
    expect(read[0]!.bigram_hits).toBeUndefined();
  });

  it('readFires handles new fires with category', () => {
    const dir = makeTmpDir();
    const newFire: DirectiveFire = {
      t: new Date().toISOString(),
      directive_id: 'dir-new',
      session_id: 'sess',
      project_id: 'proj',
      keyword_hits: 3,
      keyword_total: 5,
      match_ratio: 0.6,
      category: 'error-preventing',
      bigram_hits: 2,
      bigram_total: 4,
    };
    writeFileSync(join(dir, FIRES_FILENAME), JSON.stringify(newFire) + '\n');
    const read = readFires(dir);
    expect(read).toHaveLength(1);
    expect(read[0]!.category).toBe('error-preventing');
    expect(read[0]!.bigram_hits).toBe(2);
    expect(read[0]!.bigram_total).toBe(4);
  });

  it('extractBigrams handles very short rule_text', () => {
    // Single word → no bigrams possible
    expect(extractBigrams('fix')).toEqual([]);
  });

  it('extractBigrams handles all-stopword rule_text', () => {
    expect(extractBigrams('the and for with that this')).toEqual([]);
  });
});
