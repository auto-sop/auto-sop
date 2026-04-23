/**
 * Directive-fire detection — records when a user prompt matches an active
 * CLAUDE.md directive, enabling usage metrics without storing prompt text.
 *
 * Detection point: capture writer's UserPromptSubmit handler (already a
 * detached grandchild process, so zero impact on the shim).
 *
 * Matching: heuristic keyword matching — fast, no LLM, O(directives × keywords).
 * A fire is recorded when ≥ 2 keywords match AND ratio ≥ 0.4.
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
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

// ─── Constants ───────────────────────────────────────────

export const FIRES_FILENAME = 'directive-fires.jsonl';
export const MIN_KEYWORD_LENGTH = 3;
export const MIN_HITS = 2;
export const MIN_RATIO = 0.4;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────

export interface DirectiveFire {
  t: string;              // ISO timestamp
  directive_id: string;   // matches DirectiveHistoryEntry.id
  session_id: string;     // from hook event
  project_id: string;     // from handler context
  keyword_hits: number;   // how many keywords matched
  keyword_total: number;  // total keywords in directive
  match_ratio: number;    // keyword_hits / keyword_total
}

export interface MatchResult {
  hits: number;
  total: number;
  ratio: number;
}

export interface DirectiveInput {
  id: string;
  rule_text: string;
}

// ─── Stopwords ───────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
  'will', 'should', 'must', 'when', 'into', 'also', 'each', 'other',
  'than', 'them', 'then', 'only', 'more', 'some', 'such', 'make',
  'like', 'just', 'over', 'your', 'after', 'before', 'between', 'does',
  'about', 'being', 'very', 'could', 'would', 'these', 'those', 'every',
  'using', 'used', 'use', 'not', 'are', 'was', 'were', 'has', 'had',
  'but', 'all', 'any', 'can', 'her', 'his', 'its', 'may', 'new',
  'now', 'old', 'see', 'way', 'who', 'did', 'get', 'let', 'say',
  'she', 'too', 'our',
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
 * Check whether a prompt matches a set of directive keywords.
 * Returns null if fewer than MIN_HITS keywords match or ratio < MIN_RATIO.
 */
export function matchDirective(
  prompt: string,
  keywords: string[],
): MatchResult | null {
  if (keywords.length === 0) return null;

  // Pre-compile word-boundary regexes once per keyword set for performance.
  // Uses 'i' flag for case-insensitive matching without lowercasing the prompt.
  // Keywords are escaped to prevent regex injection from special characters.
  const patterns = keywords.map((kw) => new RegExp('\\b' + escapeRegExp(kw) + '\\b', 'i'));
  let hits = 0;
  for (const pattern of patterns) {
    if (pattern.test(prompt)) {
      hits++;
    }
  }

  const ratio = hits / keywords.length;
  if (hits < MIN_HITS || ratio < MIN_RATIO) return null;

  return {
    hits,
    total: keywords.length,
    ratio: Math.round(ratio * 1000) / 1000, // 3 decimal precision
  };
}

// ─── Detection ───────────────────────────────────────────

/**
 * Detect which directives a prompt matches. Returns DirectiveFire objects
 * for all matches. Empty directives array → immediate empty return (fast path).
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
    const match = matchDirective(prompt, keywords);
    if (match !== null) {
      fires.push({
        t: now,
        directive_id: directive.id,
        session_id: sessionId,
        project_id: projectId,
        keyword_hits: match.hits,
        keyword_total: match.total,
        match_ratio: match.ratio,
      });
    }
  }

  return fires;
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
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
