/**
 * Detector: repeated-bash-failure
 *
 * Scans turn data for Bash commands that have exited non-zero in
 * >= 3 distinct sessions. Emits one DirectiveProposal per
 * command-fingerprint meeting the threshold.
 *
 * Injection resistance: this detector NEVER copies raw `stderr`,
 * `stdout`, or any other captured output text into the proposal
 * `rule_text`. It only reads structured fields (success flag,
 * numeric exit codes, the command itself from the tool INPUT — which
 * is our own tool invocation, not attacker-controlled output) and
 * builds rule_text from a hardcoded template.
 *
 * Command fingerprint: first 100 chars of input.command with trailing
 * whitespace stripped and interior runs of whitespace collapsed to
 * a single space. Exact match only — no fuzzy matching in v13.
 */
import type { TurnData, ToolCall } from '../turn-loader.js';
import type { Detector } from './types.js';
import {
  DirectiveProposal,
  type DirectiveProposalType,
  generateProposalId,
} from '../directive-schema.js';

const DETECTOR_NAME = 'repeated-bash-failure';
const MIN_DISTINCT_SESSIONS = 3;
const FINGERPRINT_MAX_LEN = 100;

interface FailureRecord {
  session_id: string;
  turn_id: string;
  t: string;
}

export const repeatedBashFailureDetector: Detector = {
  name: DETECTOR_NAME,
  description: 'Flags Bash commands that have exited non-zero across >= 3 distinct sessions.',

  detect(turns: TurnData[]): DirectiveProposalType[] {
    // Map: fingerprint → list of failure records (one per failure)
    const groups = new Map<string, FailureRecord[]>();

    for (const turn of turns) {
      // Build pre-event index so we can look up Bash command input
      // when processing the matching post event.
      const preByUseId = new Map<string, ToolCall>();
      for (const call of turn.tool_calls) {
        if (call.event === 'pre') {
          preByUseId.set(call.tool_use_id, call);
        }
      }

      for (const call of turn.tool_calls) {
        if (call.event !== 'post') continue;
        if (call.tool !== 'Bash') continue;

        // Only count failures
        if (!isBashFailure(call)) continue;

        const pre = preByUseId.get(call.tool_use_id);
        if (!pre || !pre.input) continue;

        const command = pre.input.command;
        if (typeof command !== 'string' || command.length === 0) continue;

        const fingerprint = fingerprintCommand(command);
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

      // Build proposal — TEMPLATE ONLY, no raw output interpolation.
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

      // Validate through the same schema the framework uses — if the
      // constructed proposal fails validation (e.g. rule_text too long
      // because fingerprint was pathological), we drop it rather than
      // let downstream code handle a shape the schema rejects.
      const parsed = DirectiveProposal.safeParse(candidate);
      if (parsed.success) {
        proposals.push(parsed.data);
      }
    }

    return proposals;
  },
};

// ── Helpers ────────────────────────────────────────────────

/**
 * Fingerprint a Bash command for grouping:
 * - trim
 * - collapse interior whitespace runs to single space
 * - take first 100 chars
 */
export function fingerprintCommand(command: string): string {
  const trimmed = command.trim();
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.slice(0, FINGERPRINT_MAX_LEN);
}

/**
 * Decide whether a post-event ToolCall represents a Bash failure.
 *
 * Primary signal: `success === false`. Secondary: output.exitCode is
 * a non-zero number (belt-and-suspenders in case the hook omits the
 * success flag).
 *
 * IMPORTANT: this function reads structured fields only. It does NOT
 * inspect stderr/stdout text content.
 */
function isBashFailure(call: ToolCall): boolean {
  if (call.success === false) return true;
  if (call.output && typeof call.output === 'object') {
    const out = call.output as Record<string, unknown>;
    if (typeof out.exitCode === 'number' && out.exitCode !== 0) return true;
    // Some Claude Code tool wrappers report via `interrupted: true` on hard kill;
    // that's an environment failure, worth counting.
    if (out.interrupted === true) return true;
  }
  return false;
}

/**
 * Build the directive rule_text from a hardcoded template.
 *
 * SAFETY: the template constants here are literal strings in source
 * code. The only variable interpolated is the command fingerprint
 * (which comes from `input.command` — OUR tool invocation input, not
 * attacker-controlled tool output) and the session count (a number).
 * The fingerprint is wrapped in backticks and capped at 100 chars by
 * fingerprintCommand(). Backticks inside the fingerprint are replaced
 * with a single quote to preserve markdown code-span integrity.
 */
function buildRuleText(fingerprint: string, sessionCount: number): string {
  const safeFingerprint = fingerprint.replace(/`/g, "'");
  return (
    'Command `' +
    safeFingerprint +
    '` has exited non-zero in ' +
    sessionCount +
    ' sessions. Consider verifying prerequisites before running.'
  );
}

/**
 * Report candidate patterns (1 or 2 distinct sessions) without
 * emitting a proposal — used by the framework to surface "watching
 * K candidates" in the managed section body.
 */
export function countBashFailureCandidates(turns: TurnData[]): number {
  const groups = new Map<string, Set<string>>();

  for (const turn of turns) {
    const preByUseId = new Map<string, ToolCall>();
    for (const call of turn.tool_calls) {
      if (call.event === 'pre') preByUseId.set(call.tool_use_id, call);
    }

    for (const call of turn.tool_calls) {
      if (call.event !== 'post' || call.tool !== 'Bash') continue;
      if (!isBashFailure(call)) continue;
      const pre = preByUseId.get(call.tool_use_id);
      if (!pre || !pre.input) continue;
      const command = pre.input.command;
      if (typeof command !== 'string' || command.length === 0) continue;

      const fingerprint = fingerprintCommand(command);
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
