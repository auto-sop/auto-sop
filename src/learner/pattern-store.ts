/**
 * Pattern Candidate Store — persistent accumulation of LLM-detected
 * pattern candidates across ticks.
 *
 * Candidates live in `<project>/.auto-sop/state/pattern-candidates.jsonl`.
 * Each line is a self-contained JSON object (JSONL format) so appending
 * is safe and partial corruption only loses one line.
 *
 * Lifecycle:
 *   1. Each tick, the incremental LLM extracts new candidates and matches
 *      existing ones against fresh turns.
 *   2. mergeCandidateEvidence() unions session/turn evidence.
 *   3. graduateCandidates() promotes candidates with evidence from
 *      >= 3 distinct sessions into DirectiveProposalType objects.
 *   4. pruneStaleCandidates() removes non-graduated candidates older
 *      than maxAgeDays (default 30).
 *
 * Atomicity: writeCandidates uses temp-file + rename so a crash mid-write
 * never corrupts the on-disk file.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { type DirectiveProposalType } from './directive-schema.js';
import { extractKeywords } from '../capture/writer/directive-fire.js';

// ── Constants ──────────────────────────────────────────────

const CANDIDATES_FILE = 'pattern-candidates.jsonl';

/** Minimum distinct sessions required for graduation. */
const GRADUATION_THRESHOLD = 3;

// ── Types ──────────────────────────────────────────────────

export interface PatternCandidate {
  id: string;
  pattern: string;
  severity: 'info' | 'warning' | 'error';
  rule_text: string;
  session_ids: string[];
  turn_ids: string[];
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  graduated: boolean;
  graduated_at?: string | undefined;
  /** BUG-S1: 1-hour observation windows for graduation. Format: YYYY-MM-DDTHH */
  observation_windows?: string[];
}

// ── Read ───────────────────────────────────────────────────

/**
 * Read all pattern candidates from the JSONL file.
 * Returns empty array if the file is missing or empty.
 * Skips malformed lines silently — partial corruption only loses
 * the bad line, not the entire file.
 */
export function readCandidates(stateDir: string): PatternCandidate[] {
  const filePath = join(stateDir, CANDIDATES_FILE);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const candidates: PatternCandidate[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isValidCandidate(parsed)) {
        candidates.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return candidates;
}

// ── Write ──────────────────────────────────────────────────

/**
 * Atomically write all candidates as JSONL (temp + rename).
 * Creates the state directory if it doesn't exist.
 */
export function writeCandidates(stateDir: string, candidates: PatternCandidate[]): void {
  mkdirSync(stateDir, { recursive: true });
  const filePath = join(stateDir, CANDIDATES_FILE);
  const tmpPath = filePath + '.tmp';
  const content = candidates.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

// ── Semantic dedup (BUG-D1) ───────────────────────────────

/**
 * Jaccard similarity threshold for considering two rule texts as duplicates.
 *
 * 0.75 was chosen because 0.6 produced false positives on directive pairs
 * that differ by a single distinguishing keyword, e.g.:
 *   "Always run unit tests before committing changes"  vs
 *   "Always run integration tests before committing changes"
 * share 5/7 keywords → Jaccard 0.714, which clears 0.6 but not 0.75.
 * At 0.75, only near-identical rewording is treated as a duplicate.
 */
const SEMANTIC_DEDUP_THRESHOLD = 0.75;

/**
 * Check whether two directive rule texts are semantically duplicate
 * using Jaccard similarity on extracted keywords.
 *
 * Jaccard = |intersection| / |union|. If >= 0.75, texts are considered
 * duplicates. Returns false for empty keyword sets (too short to compare).
 */
export function isSemanticallyDuplicate(ruleTextA: string, ruleTextB: string): boolean {
  const kwA = extractKeywords(ruleTextA);
  const kwB = extractKeywords(ruleTextB);

  if (kwA.length === 0 || kwB.length === 0) return false;

  const setA = new Set(kwA);
  const setB = new Set(kwB);

  let intersection = 0;
  for (const kw of setA) {
    if (setB.has(kw)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  if (union === 0) return false;

  return intersection / union >= SEMANTIC_DEDUP_THRESHOLD;
}

// ── Observation windows (BUG-S1) ─────────────────────────

/**
 * Compute the 1-hour observation window key for a session.
 *
 * Finds the earliest finalized_at timestamp among turns with the given
 * session_id, then truncates to hour precision: YYYY-MM-DDTHH.
 *
 * @param sessionId  The session to look up.
 * @param turns      Turn data (needs session_id + finalized_at fields).
 * @returns Window key like "2026-04-25T17", or "unknown" if no turns match.
 */
export function timeWindowKey(
  sessionId: string,
  turns: ReadonlyArray<{ session_id: string; finalized_at: string }>,
): string {
  let earliest: string | null = null;
  for (const t of turns) {
    if (t.session_id === sessionId) {
      if (earliest === null || t.finalized_at < earliest) {
        earliest = t.finalized_at;
      }
    }
  }
  if (!earliest || earliest.length < 13) return 'unknown';
  // Truncate ISO timestamp to hour: "2026-04-25T17"
  return earliest.slice(0, 13);
}

// ── Merge ──────────────────────────────────────────────────

/**
 * Merge incoming candidate evidence into the existing candidate list.
 *
 * Matching is by `id` first, then by semantic similarity (BUG-D1).
 * For matches:
 *   - session_ids: union (deduplicated)
 *   - turn_ids: union (deduplicated)
 *   - occurrence_count: summed with incoming additional occurrences
 *   - last_seen: latest timestamp wins
 *   - observation_windows: union (BUG-S1)
 *
 * New candidates (no id or semantic match) are appended.
 *
 * @param sessionWindowMap  Optional map from session_id to 1-hour window key (BUG-S1).
 *                          When provided, observation_windows are tracked alongside session_ids.
 */
export function mergeCandidateEvidence(
  existing: PatternCandidate[],
  incoming: PatternCandidate[],
  sessionWindowMap?: Map<string, string>,
): PatternCandidate[] {
  const byId = new Map<string, PatternCandidate>();
  for (const c of existing) {
    byId.set(c.id, { ...c });
  }

  for (const inc of incoming) {
    // ID-based match first
    let target = byId.get(inc.id);

    // BUG-D1: If no ID match, check for semantic duplicates
    if (target === undefined) {
      for (const [, existCandidate] of byId) {
        if (isSemanticallyDuplicate(inc.rule_text, existCandidate.rule_text)) {
          target = existCandidate;
          break;
        }
      }
    }

    if (target !== undefined) {
      // Union session_ids
      const sessionSet = new Set(target.session_ids);
      for (const sid of inc.session_ids) sessionSet.add(sid);
      target.session_ids = [...sessionSet];

      // Union turn_ids
      const turnSet = new Set(target.turn_ids);
      for (const tid of inc.turn_ids) turnSet.add(tid);
      target.turn_ids = [...turnSet];

      // Sum occurrence counts
      target.occurrence_count += inc.occurrence_count;

      // Latest last_seen wins
      if (inc.last_seen > target.last_seen) {
        target.last_seen = inc.last_seen;
      }

      // BUG-S1: Track observation windows
      if (sessionWindowMap) {
        const windowSet = new Set(target.observation_windows ?? []);
        for (const sid of inc.session_ids) {
          const windowKey = sessionWindowMap.get(sid);
          // Filter 'unknown' at insertion — sessions without timestamp data
          // should never enter the window set (prevents inflation).
          if (windowKey && windowKey !== 'unknown') windowSet.add(windowKey);
        }
        target.observation_windows = [...windowSet];
      }
    } else {
      const newCandidate: PatternCandidate = { ...inc };
      // BUG-S1: Initialize observation windows for new candidates
      if (sessionWindowMap) {
        const windowSet = new Set<string>();
        for (const sid of inc.session_ids) {
          const windowKey = sessionWindowMap.get(sid);
          // Filter 'unknown' at insertion — sessions without timestamp data
          // should never enter the window set (prevents inflation).
          if (windowKey && windowKey !== 'unknown') windowSet.add(windowKey);
        }
        if (windowSet.size > 0) {
          newCandidate.observation_windows = [...windowSet];
        }
      }
      byId.set(inc.id, newCandidate);
    }
  }

  return [...byId.values()];
}

// ── Graduate ───────────────────────────────────────────────

/**
 * Promote candidates with evidence from >= 3 distinct observation windows
 * (BUG-S1). Falls back to distinct session count for backward compat with
 * old candidates that lack observation_windows.
 *
 * Returns:
 *   - graduated: DirectiveProposalType[] — newly promoted candidates
 *   - updated: PatternCandidate[] — full list with graduated flags set
 */
export function graduateCandidates(candidates: PatternCandidate[]): {
  graduated: DirectiveProposalType[];
  updated: PatternCandidate[];
} {
  const nowIso = new Date().toISOString();
  const graduated: DirectiveProposalType[] = [];
  const updated: PatternCandidate[] = [];

  for (const c of candidates) {
    // BUG-S1: Prefer observation_windows count; fall back to session_ids
    // only for old candidates that lack observation_windows entirely.
    // BUG-E1/YODA-4: Defensive filter for 'unknown' window keys — handles
    // pre-existing stored data from before insertion-time filtering was added.
    // New code filters 'unknown' at insertion (mergeCandidateEvidence), but
    // legacy candidates may still contain 'unknown' entries on disk.
    const hasWindowTracking = c.observation_windows !== undefined;
    const validWindows = hasWindowTracking
      ? c.observation_windows!.filter((w) => w !== 'unknown')
      : [];
    const distinctWindows = new Set(validWindows).size;
    // Fall back to session count ONLY for legacy candidates without
    // observation_windows. If windows were tracked but all are 'unknown',
    // distinctWindows = 0 — the candidate simply hasn't earned enough evidence.
    const distinctSessions = new Set(c.session_ids).size;
    const evidenceCount = hasWindowTracking ? distinctWindows : distinctSessions;
    if (evidenceCount >= GRADUATION_THRESHOLD && !c.graduated) {
      // Mark as graduated
      const gradCandidate: PatternCandidate = {
        ...c,
        graduated: true,
        graduated_at: nowIso,
      };
      updated.push(gradCandidate);

      // Convert to DirectiveProposalType
      graduated.push({
        id: c.id,
        detector: 'llm-inc',
        severity: c.severity,
        rule_text: c.rule_text,
        evidence: {
          session_ids: c.session_ids,
          turn_ids: c.turn_ids,
          pattern: c.pattern,
          occurrence_count: Math.max(c.occurrence_count, distinctSessions),
          first_seen: c.first_seen,
        },
        created_at: nowIso,
      });
    } else {
      updated.push({ ...c });
    }
  }

  return { graduated, updated };
}

// ── Prune ──────────────────────────────────────────────────

/**
 * Remove non-graduated candidates whose last_seen is older than
 * maxAgeDays. Graduated candidates are never pruned.
 */
export function pruneStaleCandidates(
  candidates: PatternCandidate[],
  maxAgeDays: number = 30,
): PatternCandidate[] {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return candidates.filter((c) => {
    if (c.graduated) return true;
    const lastSeenMs = new Date(c.last_seen).getTime();
    return lastSeenMs >= cutoff;
  });
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Minimal shape check for a parsed JSONL line. We verify the fields
 * exist and have the right types rather than using Zod — this is
 * internal storage, not untrusted LLM output.
 */
function isValidCandidate(v: unknown): v is PatternCandidate {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.pattern === 'string' &&
    typeof o.severity === 'string' &&
    (o.severity === 'info' || o.severity === 'warning' || o.severity === 'error') &&
    typeof o.rule_text === 'string' &&
    Array.isArray(o.session_ids) &&
    Array.isArray(o.turn_ids) &&
    typeof o.occurrence_count === 'number' &&
    typeof o.first_seen === 'string' &&
    typeof o.last_seen === 'string' &&
    typeof o.graduated === 'boolean'
  );
}

// Re-export for convenience — callers that create candidates
// from LLM output can generate deterministic ids.
export { generateProposalId } from './directive-schema.js';
