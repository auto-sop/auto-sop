/**
 * Directive-fire detection — records when a user prompt matches an active
 * CLAUDE.md directive, enabling usage metrics without storing prompt text.
 *
 * Detection point: capture writer's UserPromptSubmit handler (already a
 * detached grandchild process, so zero impact on the shim).
 *
 * Matching: bigram+unigram weighted scoring — fast, no LLM.
 * Bigram hit = 2 points, unigram hit = 1 point. Threshold: score ≥ 0.3
 * AND total hits ≥ 3. Category derived from directive severity.
 *
 * Storage: directive-fires.jsonl — append-only JSONL in the project state dir.
 * File mode 0600 — never world-readable.
 *
 * Privacy: NEVER stores user prompt text in fire events (PRIV-02).
 *
 * Kill-switch: AUTO_SOP_DISABLE_FIRE_DETECTION=1 env var.
 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fsyncFile } from '../../atomic/safe-fsync.js';

// ─── Constants ───────────────────────────────────────────

export const FIRES_FILENAME = 'directive-fires.jsonl';
export const MIN_KEYWORD_LENGTH = 3;
/** @deprecated — legacy unigram-only thresholds; kept for backward compat reference */
export const MIN_HITS = 2;
/** @deprecated — legacy unigram-only thresholds; kept for backward compat reference */
export const MIN_RATIO = 0.4;

/** Combined scoring thresholds (v31 bigram+unigram) */
export const MIN_COMBINED_HITS = 3; // unigrams + bigrams combined
export const MIN_COMBINED_SCORE = 0.3; // weighted score threshold
export const BIGRAM_WEIGHT = 2; // bigram hit worth 2 points
export const UNIGRAM_WEIGHT = 1; // unigram hit worth 1 point

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────

export type FireCategory = 'error-preventing' | 'efficiency' | 'best-practice';

export interface DirectiveFire {
  t: string; // ISO timestamp
  directive_id: string; // matches DirectiveHistoryEntry.id
  session_id: string; // from hook event
  project_id: string; // from handler context
  keyword_hits: number; // how many keywords matched
  keyword_total: number; // total keywords in directive
  match_ratio: number; // keyword_hits / keyword_total
  /** v31: fire category derived from directive severity. Optional for backward compat. */
  category?: FireCategory;
  /** v31: number of bigram matches. Optional for backward compat. */
  bigram_hits?: number;
  /** v31: total bigrams in directive. Optional for backward compat. */
  bigram_total?: number;
}

export interface MatchResult {
  hits: number;
  total: number;
  ratio: number;
  /** v31: bigram match count */
  bigram_hits: number;
  /** v31: total bigrams */
  bigram_total: number;
}

export interface DirectiveInput {
  id: string;
  rule_text: string;
  /** v31: directive severity for category derivation. Optional for backward compat. */
  severity?: 'info' | 'warning' | 'error';
}

// ─── Stopwords ───────────────────────────────────────────

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'been',
  'will',
  'should',
  'must',
  'when',
  'into',
  'also',
  'each',
  'other',
  'than',
  'them',
  'then',
  'only',
  'more',
  'some',
  'such',
  'make',
  'like',
  'just',
  'over',
  'your',
  'after',
  'before',
  'between',
  'does',
  'about',
  'being',
  'very',
  'could',
  'would',
  'these',
  'those',
  'every',
  'using',
  'used',
  'use',
  'not',
  'are',
  'was',
  'were',
  'has',
  'had',
  'but',
  'all',
  'any',
  'can',
  'her',
  'his',
  'its',
  'may',
  'new',
  'now',
  'old',
  'see',
  'way',
  'who',
  'did',
  'get',
  'let',
  'say',
  'she',
  'too',
  'our',
]);

// ─── Keyword extraction ─────────────────────────────────

/**
 * Extract meaningful keywords from a directive's rule text.
 * Lowercases, splits on whitespace/punctuation, filters stopwords
 * and short tokens, deduplicates, and returns sorted.
 */
export function extractKeywords(ruleText: string): string[] {
  const tokens = ruleText
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(t));

  const unique = [...new Set(tokens)];
  unique.sort();
  return unique;
}

// ─── Bigram extraction ─────────────────────────────────

/**
 * Extract consecutive word pairs (bigrams) from rule text.
 * Lowercased, filtered: removes pairs where both words are stopwords,
 * keeps only bigrams with combined length ≥ 7 chars.
 *
 * Example: "Always pull user-controlled files before dev work"
 * → ["always pull", "pull user", "user controlled", "controlled files",
 *    "files before", "before dev", "dev work"]
 */
export function extractBigrams(ruleText: string): string[] {
  const tokens = ruleText
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((t) => t.length > 0);

  if (tokens.length < 2) return [];

  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;

    // Skip pairs where both words are stopwords
    if (STOPWORDS.has(a) && STOPWORDS.has(b)) continue;

    // Keep only bigrams with combined length ≥ 7 chars
    if (a.length + b.length < 7) continue;

    bigrams.push(`${a} ${b}`);
  }

  // Deduplicate while preserving order
  return [...new Set(bigrams)];
}

// ─── Regex helper ───────────────────────────────────────

/**
 * Escape special regex characters in a string so it can be used
 * inside `new RegExp(...)` as a literal match.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Matching ────────────────────────────────────────────

/**
 * Check whether a prompt matches a directive using combined bigram+unigram scoring.
 *
 * Scoring: unigram hit = 1 point, bigram hit = 2 points (more specific).
 * Score = (unigram_points + bigram_points) / (unigram_total + bigram_total * 2).
 * Threshold: score >= 0.3 AND total hits >= 3 (unigrams + bigrams combined).
 *
 * @param prompt      User prompt text
 * @param keywords    Unigram keywords extracted from directive rule_text
 * @param bigrams     Bigram pairs extracted from directive rule_text (optional for backward compat)
 */
export function matchDirective(
  prompt: string,
  keywords: string[],
  bigrams: string[] = [],
): MatchResult | null {
  if (keywords.length === 0) return null;

  // Unigram matching — word-boundary regex, case-insensitive
  const unigramPatterns = keywords.map((kw) => new RegExp('\\b' + escapeRegExp(kw) + '\\b', 'i'));
  let unigramHits = 0;
  for (const pattern of unigramPatterns) {
    if (pattern.test(prompt)) {
      unigramHits++;
    }
  }

  // Bigram matching — word-boundary regex, case-insensitive
  let bigramHits = 0;
  for (const bigram of bigrams) {
    const parts = bigram.split(' ');
    if (parts.length !== 2) continue;
    const bigramRegex = new RegExp(
      '\\b' + escapeRegExp(parts[0]!) + '\\s+' + escapeRegExp(parts[1]!) + '\\b',
      'i',
    );
    if (bigramRegex.test(prompt)) {
      bigramHits++;
    }
  }

  const totalHits = unigramHits + bigramHits;
  const unigramPoints = unigramHits * UNIGRAM_WEIGHT;
  const bigramPoints = bigramHits * BIGRAM_WEIGHT;
  const maxPoints = keywords.length * UNIGRAM_WEIGHT + bigrams.length * BIGRAM_WEIGHT;

  if (maxPoints === 0) return null;

  const score = (unigramPoints + bigramPoints) / maxPoints;

  if (totalHits < MIN_COMBINED_HITS || score < MIN_COMBINED_SCORE) return null;

  return {
    hits: unigramHits,
    total: keywords.length,
    ratio: Math.round(score * 1000) / 1000, // 3 decimal precision
    bigram_hits: bigramHits,
    bigram_total: bigrams.length,
  };
}

// ─── Category derivation ────────────────────────────────

/**
 * Derive fire category from directive severity.
 * error → error-preventing, warning → efficiency, info → best-practice.
 */
function severityToCategory(severity?: 'info' | 'warning' | 'error'): FireCategory {
  switch (severity) {
    case 'error':
      return 'error-preventing';
    case 'warning':
      return 'efficiency';
    case 'info':
    default:
      return 'best-practice';
  }
}

// ─── Detection ───────────────────────────────────────────

/**
 * Detect which directives a prompt matches. Returns DirectiveFire objects
 * for all matches. Empty directives array → immediate empty return (fast path).
 *
 * v31: uses combined bigram+unigram scoring and assigns fire category
 * from directive severity.
 *
 * PRIV-02: prompt text is NEVER stored in the returned fire events.
 */
export function detectDirectiveFires(
  prompt: string,
  directives: DirectiveInput[],
  sessionId: string,
  projectId: string,
): DirectiveFire[] {
  if (directives.length === 0) return [];

  const now = new Date().toISOString();
  const fires: DirectiveFire[] = [];

  for (const directive of directives) {
    const keywords = extractKeywords(directive.rule_text);
    const bigrams = extractBigrams(directive.rule_text);
    const match = matchDirective(prompt, keywords, bigrams);
    if (match !== null) {
      fires.push({
        t: now,
        directive_id: directive.id,
        session_id: sessionId,
        project_id: projectId,
        keyword_hits: match.hits,
        keyword_total: match.total,
        match_ratio: match.ratio,
        category: severityToCategory(directive.severity),
        bigram_hits: match.bigram_hits,
        bigram_total: match.bigram_total,
      });
    }
  }

  return fires;
}

// ─── Self-reported fire detection (V46) ──────────────────

/**
 * Pattern for Claude's self-reported directive application markers.
 * Matches [sop:applied:<id>] where id is alphanumeric + hyphens + underscores,
 * capped at 64 characters to prevent abuse.
 * Used with String.matchAll to avoid stateful lastIndex issues.
 */
const SELF_REPORT_PATTERN = /\[sop:applied:([a-zA-Z0-9_-]{1,64})\]/g;

/**
 * Parse Claude's text output for self-reported directive fire markers.
 * Returns a deduplicated array of directive IDs that Claude self-reported
 * as having influenced its action.
 *
 * @param output  Claude's text output (response text from a turn)
 * @returns Array of unique directive IDs (e.g. ['sop-7ced', 'det-0000'])
 */
export function detectSelfReportedFires(output: string): string[] {
  if (!output || output.length === 0) return [];

  const ids = new Set<string>();
  for (const match of output.matchAll(SELF_REPORT_PATTERN)) {
    ids.add(match[1]!);
  }

  return Array.from(ids);
}

// ─── File I/O ────────────────────────────────────────────

function firesPath(stateDir: string): string {
  return join(stateDir, FIRES_FILENAME);
}

/**
 * Append fire events as JSONL. Creates the file if it doesn't exist (mode 0600).
 * Best-effort — never throws (same pattern as capture writer error logging).
 */
export function appendFires(stateDir: string, fires: DirectiveFire[]): void {
  if (fires.length === 0) return;

  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = firesPath(stateDir);
    const lines = fires.map((f) => JSON.stringify(f)).join('\n') + '\n';
    appendFileSync(path, lines, { mode: 0o600 });
  } catch {
    // Best-effort — never throw (same as capture writer pattern)
  }
}

/**
 * Read fire events from JSONL. Skips malformed lines.
 * If `since` is provided (ISO string), filters to fires after that date.
 * Returns sorted by timestamp ascending.
 */
export function readFires(stateDir: string, since?: string): DirectiveFire[] {
  const path = firesPath(stateDir);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return [];
  }

  if (raw.length === 0) return [];

  const sinceMs = since !== undefined ? Date.parse(since) : undefined;
  const fires: DirectiveFire[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      // Minimal validation — must have required fields
      if (
        typeof entry.t !== 'string' ||
        typeof entry.directive_id !== 'string' ||
        typeof entry.session_id !== 'string' ||
        typeof entry.project_id !== 'string' ||
        typeof entry.keyword_hits !== 'number' ||
        typeof entry.keyword_total !== 'number' ||
        typeof entry.match_ratio !== 'number'
      ) {
        continue;
      }

      if (sinceMs !== undefined && Number.isFinite(sinceMs)) {
        const entryMs = Date.parse(entry.t);
        if (!Number.isFinite(entryMs) || entryMs <= sinceMs) continue;
      }

      fires.push(entry as unknown as DirectiveFire);
    } catch {
      // Skip malformed lines
    }
  }

  // Sort by timestamp ascending
  fires.sort((a, b) => {
    const aMs = Date.parse(a.t);
    const bMs = Date.parse(b.t);
    return aMs - bMs;
  });

  return fires;
}

/**
 * Compact fire events — remove entries older than maxAgeDays.
 * Atomic rewrite (tmp + fsync + rename) so readers never see partial content.
 * Returns count of removed entries.
 */
export function compactFires(stateDir: string, maxAgeDays: number): number {
  const path = firesPath(stateDir);
  if (!existsSync(path)) return 0;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    return 0;
  }

  if (raw.length === 0) return 0;

  const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
  const keep: string[] = [];
  let removedCount = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const entry = JSON.parse(trimmed) as { t?: string };
      if (typeof entry.t === 'string') {
        const entryMs = Date.parse(entry.t);
        if (Number.isFinite(entryMs) && entryMs < cutoffMs) {
          removedCount++;
          continue;
        }
      }
      keep.push(trimmed);
    } catch {
      // Malformed lines are dropped during compaction
      removedCount++;
    }
  }

  // Atomic rewrite
  const tmpPath = path + '.tmp';
  try {
    const content = keep.length > 0 ? keep.join('\n') + '\n' : '';
    writeFileSync(tmpPath, content, { mode: 0o600 });
    fsyncFile(tmpPath);
    renameSync(tmpPath, path);
  } catch {
    // Clean up tmp on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    return 0;
  }

  return removedCount;
}
