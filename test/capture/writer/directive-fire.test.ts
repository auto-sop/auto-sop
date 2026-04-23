import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  extractKeywords,
  matchDirective,
  detectDirectiveFires,
  appendFires,
  readFires,
  compactFires,
  escapeRegExp,
  FIRES_FILENAME,
  MIN_KEYWORD_LENGTH,
  MIN_HITS,
  MIN_RATIO,
} from '~/capture/writer/directive-fire.js';
import type { DirectiveFire, DirectiveInput } from '~/capture/writer/directive-fire.js';

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
  it('returns match stats when threshold is met', () => {
    const keywords = ['validate', 'input', 'database', 'queries'];
    const result = matchDirective('please validate user input before running database queries', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(4);
    expect(result!.total).toBe(4);
    expect(result!.ratio).toBe(1);
  });

  it('returns null when fewer than MIN_HITS keywords match', () => {
    const keywords = ['validate', 'input', 'database', 'queries', 'security'];
    const result = matchDirective('please validate something', keywords);
    // Only 1 hit — below MIN_HITS=2
    expect(result).toBeNull();
  });

  it('returns null when ratio is below MIN_RATIO', () => {
    // 10 keywords, need at least 4 hits for 0.4 ratio
    const keywords = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh', 'iii', 'jjj'];
    // Only 2 hits → ratio 0.2 < 0.4
    const result = matchDirective('something with aaa and bbb', keywords);
    expect(result).toBeNull();
  });

  it('returns null for empty keywords', () => {
    expect(matchDirective('some prompt', [])).toBeNull();
  });

  it('is case-insensitive for prompt matching', () => {
    const keywords = ['validate', 'input'];
    const result = matchDirective('VALIDATE YOUR INPUT', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(2);
  });

  it('rounds ratio to 3 decimal places', () => {
    // 3 keywords, 2 hits → 0.6666... → 0.667
    const keywords = ['alpha', 'beta', 'gamma'];
    const result = matchDirective('use alpha and beta in code', keywords);
    expect(result).not.toBeNull();
    expect(result!.ratio).toBe(0.667);
  });

  it('matches when exactly at MIN_HITS and MIN_RATIO threshold', () => {
    // 5 keywords, 2 hits → ratio 0.4 exactly
    const keywords = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const result = matchDirective('use alpha and beta', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(2);
    expect(result!.ratio).toBe(0.4);
  });

  it('returns null for prompt with no matching keywords', () => {
    const keywords = ['validate', 'database', 'queries'];
    expect(matchDirective('completely unrelated text about weather', keywords)).toBeNull();
  });

  it('handles keywords with regex special characters safely', () => {
    // Keywords like "c++" or "node.js" contain regex special chars
    // that must be escaped to avoid regex syntax errors
    const keywords = ['node', 'error'];
    // Should not throw even if keywords were to contain special chars
    expect(() => matchDirective('fix the node error please', keywords)).not.toThrow();
    const result = matchDirective('fix the node error please', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(2);
  });

  it('uses word boundaries to avoid substring matches', () => {
    const keywords = ['port', 'log'];
    // "port" should NOT match inside "report" or "transport"
    // "log" should NOT match inside "catalog" or "blog"
    const result = matchDirective('the report from the catalog is ready', keywords);
    expect(result).toBeNull();
  });

  it('word boundary matching: matches whole words only', () => {
    const keywords = ['port', 'log'];
    // Both match as whole words
    const result = matchDirective('check the port and read the log', keywords);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(2);
  });
});

// ─── detectDirectiveFires ────────────────────────────────

describe('detectDirectiveFires', () => {
  const SESSION_ID = 'sess-abc';
  const PROJECT_ID = 'proj-xyz';

  it('returns fires for matching directives', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries' },
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
    expect(fires[0]!.keyword_hits).toBeGreaterThanOrEqual(MIN_HITS);
    expect(fires[0]!.match_ratio).toBeGreaterThanOrEqual(MIN_RATIO);
  });

  it('returns empty array for empty directives (fast path)', () => {
    expect(detectDirectiveFires('some prompt', [], SESSION_ID, PROJECT_ID)).toEqual([]);
  });

  it('skips directives that do not match', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries' },
      { id: 'dir-2', rule_text: 'Use TypeScript strict mode everywhere' },
    ];
    const fires = detectDirectiveFires(
      'please enable typescript strict mode in the config',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    // Only dir-2 should match (typescript, strict, mode, config)
    const matchedIds = fires.map((f) => f.directive_id);
    expect(matchedIds).toContain('dir-2');
  });

  it('can match multiple directives', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Validate all user input parameters carefully' },
      { id: 'dir-2', rule_text: 'Validate form input fields correctly' },
    ];
    const fires = detectDirectiveFires(
      'how to validate user input fields and form parameters',
      directives,
      SESSION_ID,
      PROJECT_ID,
    );
    expect(fires.length).toBeGreaterThanOrEqual(1);
  });

  it('never stores prompt text in fire events', () => {
    const prompt = 'super secret prompt text that should never appear';
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'super secret prompt text handling' },
    ];
    const fires = detectDirectiveFires(prompt, directives, SESSION_ID, PROJECT_ID);
    for (const fire of fires) {
      const serialized = JSON.stringify(fire);
      expect(serialized).not.toContain('super secret prompt text that should never appear');
    }
  });

  it('populates all required fields in DirectiveFire', () => {
    const directives: DirectiveInput[] = [
      { id: 'dir-1', rule_text: 'Always validate input before database queries' },
    ];
    const fires = detectDirectiveFires(
      'validate input database queries check',
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

  it('matchDirective with exactly 1 keyword (always null since MIN_HITS=2)', () => {
    const result = matchDirective('something about alpha', ['alpha']);
    // Can't reach MIN_HITS=2 with only 1 keyword
    expect(result).toBeNull();
  });

  it('matchDirective with exactly 2 keywords both matching', () => {
    const result = matchDirective('alpha and beta values', ['alpha', 'beta']);
    expect(result).not.toBeNull();
    expect(result!.hits).toBe(2);
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
});
