/**
 * Incremental LLM Response Parser — parses the output of `claude -p`
 * when using the incremental prompt (llm-prompt-incremental.ts).
 *
 * The response shape expected from the LLM:
 * ```json
 * {
 *   "new_candidates": [
 *     { "pattern": "...", "severity": "...", "rule_text": "...",
 *       "turn_ids": ["..."], "occurrence_count": N }
 *   ],
 *   "matched_existing": [
 *     { "candidate_id": "...", "turn_ids": ["..."],
 *       "additional_occurrences": N }
 *   ],
 *   "summary": "..."
 * }
 * ```
 *
 * Security posture:
 *   - Two-layer JSON unwrap (same as llm-mode.ts for claude CLI wrapper).
 *   - Markdown fence stripping for resilience.
 *   - Zod-style validation: rule_text 10–500 chars, severity enum.
 *   - Invalid entries silently dropped — never throws.
 *   - candidate_id format validated against /^[a-z0-9-]+$/.
 *
 * Public surface:
 *   - parseIncrementalResponse(stdout, sessionId, turnData)
 *     Returns { newCandidates, matchedExisting } — always well-formed.
 */
import { generateProposalId } from './directive-schema.js';
import type { PatternCandidate } from './pattern-store.js';
import type { TurnData } from './turn-loader.js';

// ── Constants ──────────────────────────────────────────────

const VALID_SEVERITIES = new Set(['info', 'warning', 'error']);
const CANDIDATE_ID_RE = /^[a-z0-9-]+$/;
const MIN_RULE_TEXT = 10;
const MAX_RULE_TEXT = 500;

// ── Public types ───────────────────────────────────────────

export interface MatchedExisting {
  candidateId: string;
  turnIds: string[];
  additionalOccurrences: number;
}

export interface IncrementalParseResult {
  newCandidates: PatternCandidate[];
  matchedExisting: MatchedExisting[];
  summary: string;
}

// ── Public entry ───────────────────────────────────────────

/**
 * Parse the incremental LLM response from `claude -p` stdout.
 *
 * Never throws. On any parse failure, returns empty results so the
 * caller can continue with rule-based detectors and preserve
 * existing candidates untouched.
 *
 * @param stdout      Raw stdout from the `claude -p` child process.
 * @param sessionId   Current session ID to populate on new candidates.
 * @param turnData    Turn data from this tick — used for timestamps
 *                    and turn_id extraction.
 */
export function parseIncrementalResponse(
  stdout: string,
  sessionId: string,
  turnData: TurnData[],
): IncrementalParseResult {
  const empty: IncrementalParseResult = { newCandidates: [], matchedExisting: [], summary: '' };

  // 1. Two-layer JSON unwrap (same as llm-mode.ts)
  const innerText = extractInnerText(stdout);
  if (innerText === null) return empty;

  // 2. Parse inner JSON, stripping markdown fences if present
  let inner: unknown;
  try {
    inner = JSON.parse(stripMarkdownFences(innerText.trim()));
  } catch {
    return empty;
  }

  if (inner === null || typeof inner !== 'object') return empty;

  const obj = inner as Record<string, unknown>;

  // 3. Derive timestamps from turnData
  const timestamps = turnData.map((t) => t.finalized_at).filter((t) => t.length > 0);
  const firstSeen = timestamps.length > 0 ? timestamps[0]! : new Date().toISOString();
  const lastSeen =
    timestamps.length > 0 ? timestamps[timestamps.length - 1]! : new Date().toISOString();

  // 4. Parse new_candidates
  const newCandidates: PatternCandidate[] = [];
  const rawNewCandidates: unknown[] = Array.isArray(obj.new_candidates) ? obj.new_candidates : [];

  for (const raw of rawNewCandidates) {
    if (raw === null || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;

    // Validate required fields
    const pattern = typeof c.pattern === 'string' ? c.pattern : '';
    const severity = typeof c.severity === 'string' ? c.severity : '';
    const ruleText = typeof c.rule_text === 'string' ? c.rule_text : '';
    const turnIds = Array.isArray(c.turn_ids)
      ? (c.turn_ids as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const occurrenceCount =
      typeof c.occurrence_count === 'number' &&
      Number.isInteger(c.occurrence_count) &&
      c.occurrence_count > 0
        ? c.occurrence_count
        : 1;

    // Validate severity enum
    if (!VALID_SEVERITIES.has(severity)) continue;

    // Validate rule_text length
    if (ruleText.length < MIN_RULE_TEXT || ruleText.length > MAX_RULE_TEXT) continue;

    // Skip empty pattern
    if (pattern.length === 0) continue;

    const id = generateProposalId('llm-inc', pattern);

    newCandidates.push({
      id,
      pattern,
      severity: severity as 'info' | 'warning' | 'error',
      rule_text: ruleText,
      session_ids: [sessionId],
      turn_ids: turnIds,
      occurrence_count: occurrenceCount,
      first_seen: firstSeen,
      last_seen: lastSeen,
      graduated: false,
    });
  }

  // 5. Parse matched_existing
  const matchedExisting: MatchedExisting[] = [];
  const rawMatched: unknown[] = Array.isArray(obj.matched_existing) ? obj.matched_existing : [];

  for (const raw of rawMatched) {
    if (raw === null || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;

    const candidateId = typeof m.candidate_id === 'string' ? m.candidate_id : '';
    const turnIds = Array.isArray(m.turn_ids)
      ? (m.turn_ids as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];
    const additionalOccurrences =
      typeof m.additional_occurrences === 'number' &&
      Number.isInteger(m.additional_occurrences) &&
      m.additional_occurrences > 0
        ? m.additional_occurrences
        : 1;

    // Skip if candidate_id is empty or invalid format
    if (candidateId.length === 0 || !CANDIDATE_ID_RE.test(candidateId)) continue;

    matchedExisting.push({
      candidateId,
      turnIds,
      additionalOccurrences,
    });
  }

  // 6. Extract summary
  const summary = typeof obj.summary === 'string' ? obj.summary : '';

  return { newCandidates, matchedExisting, summary };
}

// ── Internals (same patterns as llm-mode.ts) ──────────────

/**
 * Pull the LLM's response text out of the claude CLI JSON wrapper.
 * Returns `null` only when the wrapper itself doesn't parse as JSON.
 *
 * Handles three shapes:
 *   1. { "result": "<assistant text>", ... } — standard wrapper
 *   2. Top-level string — raw assistant text
 *   3. Anything else — return raw stdout for second-pass parsing
 */
function extractInnerText(stdout: string): string | null {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    outer !== null &&
    typeof outer === 'object' &&
    'result' in outer &&
    typeof (outer as { result?: unknown }).result === 'string'
  ) {
    return (outer as { result: string }).result;
  }
  if (typeof outer === 'string') return outer;
  return stdout;
}

/**
 * Strip a single ```json … ``` (or ``` … ```) fence if the LLM
 * ignored the "no fences" instruction. Idempotent for clean input.
 */
function stripMarkdownFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m && m[1] !== undefined ? m[1].trim() : s;
}
