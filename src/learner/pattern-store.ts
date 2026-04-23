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
import { join, dirname } from 'node:path';
import { generateProposalId, type DirectiveProposalType } from './directive-schema.js';

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

// ── Merge ──────────────────────────────────────────────────

/**
 * Merge incoming candidate evidence into the existing candidate list.
 *
 * Matching is by `id`. For matches:
 *   - session_ids: union (deduplicated)
 *   - turn_ids: union (deduplicated)
 *   - occurrence_count: summed with incoming additional occurrences
 *   - last_seen: latest timestamp wins
 *
 * New candidates (no id match) are appended.
 */
export function mergeCandidateEvidence(
  existing: PatternCandidate[],
  incoming: PatternCandidate[],
): PatternCandidate[] {
  const byId = new Map<string, PatternCandidate>();
  for (const c of existing) {
    byId.set(c.id, { ...c });
  }

  for (const inc of incoming) {
    const prev = byId.get(inc.id);
    if (prev !== undefined) {
      // Union session_ids
      const sessionSet = new Set(prev.session_ids);
      for (const sid of inc.session_ids) sessionSet.add(sid);
      prev.session_ids = [...sessionSet];

      // Union turn_ids
      const turnSet = new Set(prev.turn_ids);
      for (const tid of inc.turn_ids) turnSet.add(tid);
      prev.turn_ids = [...turnSet];

      // Sum occurrence counts
      prev.occurrence_count += inc.occurrence_count;

      // Latest last_seen wins
      if (inc.last_seen > prev.last_seen) {
        prev.last_seen = inc.last_seen;
      }
    } else {
      byId.set(inc.id, { ...inc });
    }
  }

  return [...byId.values()];
}

// ── Graduate ───────────────────────────────────────────────

/**
 * Promote candidates with evidence from >= 3 distinct sessions.
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
    const distinctSessions = new Set(c.session_ids).size;
    if (distinctSessions >= GRADUATION_THRESHOLD && !c.graduated) {
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
          occurrence_count: c.occurrence_count,
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
