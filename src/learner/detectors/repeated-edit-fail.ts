/**
 * Detector: repeated-edit-fail
 *
 * Flags the Edit tool failing with an exact-string-match error on the
 * same file across >= 3 distinct sessions. The cross-session signal
 * suggests Claude repeatedly tries to Edit the file without re-Reading
 * it first, or that the file changes underneath Claude.
 *
 * Captured-data shape reference (from
 * ~/Developer/wrbeautiful-shopify-theme/.auto-sop/captures/):
 *
 *   Successful Edit post event:
 *   {"event":"post","tool_use_id":"toolu_…","output":{
 *       "filePath":"…","oldString":"…","newString":"…",
 *       "originalFile":"…","structuredPatch":[…],
 *       "userModified":false,"replaceAll":false},
 *     "success":true,"t":"…"}
 *
 *   No Edit FAILURE examples exist in the captured corpus at the time
 *   this detector was written. Based on Claude Code's general tool
 *   contract, a failed Edit produces `success: false` and (typically)
 *   an error message describing the problem. This detector relies on
 *   the `success === false` signal as the primary indicator, and falls
 *   back to checking whether `output.error` (if present) contains one
 *   of the known match-failure phrases.
 *
 * Injection resistance: like repeated-bash-failure, this detector
 * NEVER copies raw `output` text into the proposal rule_text. It
 * reads `input.file_path` (our OWN tool invocation, not captured
 * output) and the success flag.
 */
import type { TurnData, ToolCall } from '../turn-loader.js';
import type { Detector } from './types.js';
import {
  DirectiveProposal,
  type DirectiveProposalType,
  generateProposalId,
} from '../directive-schema.js';

const DETECTOR_NAME = 'repeated-edit-fail';
const MIN_DISTINCT_SESSIONS = 3;
const FILE_FINGERPRINT_MAX_LEN = 200;

/** Error phrases that indicate an exact-string-match failure, used as
 *  a belt-and-suspenders signal alongside `success === false`. Kept as
 *  lowercase substrings for case-insensitive matching. */
const MATCH_FAILURE_PHRASES = [
  'string to replace',
  'not found',
  'not unique',
  'no matches',
  'string not found',
  'did not match',
  'match failed',
];

interface FailureRecord {
  session_id: string;
  turn_id: string;
  t: string;
}

export const repeatedEditFailDetector: Detector = {
  name: DETECTOR_NAME,
  description:
    'Flags Edit tool exact-string-match failures on the same file across >= 3 distinct sessions.',

  detect(turns: TurnData[]): DirectiveProposalType[] {
    const groups = new Map<string, FailureRecord[]>();

    for (const turn of turns) {
      const preByUseId = new Map<string, ToolCall>();
      for (const call of turn.tool_calls) {
        if (call.event === 'pre') preByUseId.set(call.tool_use_id, call);
      }

      for (const call of turn.tool_calls) {
        if (call.event !== 'post') continue;
        if (call.tool !== 'Edit') continue;
        if (!isEditMatchFailure(call)) continue;

        const pre = preByUseId.get(call.tool_use_id);
        if (!pre || !pre.input) continue;

        const filePath = pre.input.file_path;
        if (typeof filePath !== 'string' || filePath.length === 0) continue;

        const fingerprint = fingerprintFilePath(filePath);
        if (fingerprint.length < 1) continue;

        const arr = groups.get(fingerprint) ?? [];
        arr.push({
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          t: call.t || turn.finalized_at,
        });
        groups.set(fingerprint, arr);
      }
    }

    const proposals: DirectiveProposalType[] = [];
    const nowIso = new Date().toISOString();

    for (const [fingerprint, failures] of groups) {
      const distinctSessions = new Set(failures.map((f) => f.session_id));
      if (distinctSessions.size < MIN_DISTINCT_SESSIONS) continue;

      const sessionIds = [...distinctSessions].sort();
      const turnIds = [...new Set(failures.map((f) => f.turn_id))].sort();
      const firstSeen =
        failures
          .map((f) => f.t)
          .filter((t) => t.length > 0)
          .sort()[0] ?? nowIso;

      const rule_text = buildRuleText(fingerprint, distinctSessions.size);
      const id = generateProposalId(DETECTOR_NAME, fingerprint);

      const candidate = {
        id,
        detector: DETECTOR_NAME,
        severity: 'warning' as const,
        rule_text,
        evidence: {
          session_ids: sessionIds,
          turn_ids: turnIds,
          pattern: fingerprint,
          occurrence_count: failures.length,
          first_seen: firstSeen,
        },
        created_at: nowIso,
      };

      const parsed = DirectiveProposal.safeParse(candidate);
      if (parsed.success) proposals.push(parsed.data);
    }

    return proposals;
  },
};

// ── Helpers ────────────────────────────────────────────────

/**
 * Fingerprint a file path for grouping:
 * - Strip any path prefix up to and including "[REDACTED:<hash>]" or
 *   "[REDACTED]" (scrubber-produced prefixes) — keeps the intra-project
 *   part that is comparable across sessions.
 * - Strip leading slashes.
 * - Cap length to prevent pathological fingerprints.
 *
 * Exact match only — no canonicalization beyond this.
 */
export function fingerprintFilePath(filePath: string): string {
  let result = filePath;

  // Remove scrubbed prefixes that precede the intra-project path.
  // Patterns observed in captures: "[REDACTED:8a3a]-shopify-theme/..."
  // Strip leading "[REDACTED:...]" or "[REDACTED]" segments.
  result = result.replace(/^\[REDACTED(:[^\]]*)?\][^/]*\//, '');

  // Strip leading slashes so "/abs/path/foo.ts" groups with "path/foo.ts".
  // (We intentionally DON'T try to compute a "relative from project root"
  //  here since project roots aren't known to detectors — the detector
  //  receives pre-scrubbed data.)
  result = result.replace(/^\/+/, '');

  return result.slice(0, FILE_FINGERPRINT_MAX_LEN);
}

/**
 * Decide whether a post-event ToolCall represents an Edit exact-match
 * failure. Uses structured flags + phrase check on `output.error` (if
 * present). Does NOT copy the error text into any output of this
 * detector — only used as a boolean signal.
 */
function isEditMatchFailure(call: ToolCall): boolean {
  if (call.success === false) return true;
  if (call.output && typeof call.output === 'object') {
    const out = call.output as Record<string, unknown>;
    if (out.interrupted === true) return true;

    // Belt-and-suspenders phrase check — only used as a boolean.
    const errText = typeof out.error === 'string' ? out.error : '';
    const msgText = typeof out.message === 'string' ? out.message : '';
    const combined = (errText + ' ' + msgText).toLowerCase();
    for (const phrase of MATCH_FAILURE_PHRASES) {
      if (combined.includes(phrase)) return true;
    }
  }
  return false;
}

/**
 * Build rule_text from a hardcoded template.
 *
 * SAFETY: `safeFile` is the `input.file_path` of the Edit tool call.
 * This is OUR own tool invocation parameter (chosen by Claude, not
 * content returned by an external process), and it is further capped
 * and scrubbed of backticks. No captured `output`/error text is
 * interpolated here.
 */
function buildRuleText(fingerprint: string, sessionCount: number): string {
  const safeFile = fingerprint.replace(/`/g, "'");
  return (
    'Edit exact-string-match has failed in ' +
    sessionCount +
    ' sessions for `' +
    safeFile +
    '`. Always Read the target file immediately before calling Edit to ensure the content is current.'
  );
}

/**
 * Report candidate patterns (1 or 2 distinct sessions) without emitting
 * proposals. Used by the framework for the "tracking K candidates"
 * status line.
 */
export function countEditFailureCandidates(turns: TurnData[]): number {
  const groups = new Map<string, Set<string>>();

  for (const turn of turns) {
    const preByUseId = new Map<string, ToolCall>();
    for (const call of turn.tool_calls) {
      if (call.event === 'pre') preByUseId.set(call.tool_use_id, call);
    }

    for (const call of turn.tool_calls) {
      if (call.event !== 'post' || call.tool !== 'Edit') continue;
      if (!isEditMatchFailure(call)) continue;
      const pre = preByUseId.get(call.tool_use_id);
      if (!pre || !pre.input) continue;
      const filePath = pre.input.file_path;
      if (typeof filePath !== 'string' || filePath.length === 0) continue;

      const fingerprint = fingerprintFilePath(filePath);
      if (fingerprint.length < 1) continue;

      const set = groups.get(fingerprint) ?? new Set<string>();
      set.add(turn.session_id);
      groups.set(fingerprint, set);
    }
  }

  let candidates = 0;
  for (const set of groups.values()) {
    if (set.size >= 1 && set.size < MIN_DISTINCT_SESSIONS) candidates++;
  }
  return candidates;
}
