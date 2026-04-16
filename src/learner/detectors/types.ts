/**
 * Detector framework types.
 *
 * A Detector examines all loaded turn data for one specific pattern
 * and returns zero or more DirectiveProposals. The learner framework
 * filters proposals by N>=3-session threshold via schema validation
 * (see directive-schema.ts) and writes valid ones to CLAUDE.md.
 *
 * Contract:
 * - Detectors MUST NEVER copy raw `output`/`stderr`/`stdout` text from
 *   a ToolCall into a DirectiveProposal.rule_text. Only structured
 *   fields (exit codes, success flag, file paths from input) may be
 *   used, and rule_text must be built from template strings hardcoded
 *   in the detector source.
 * - Detectors MUST be pure (no I/O) — they receive all data via arg.
 * - Detectors MUST be failure-tolerant — malformed ToolCall entries
 *   should be skipped, never throw.
 */
import type { TurnData } from '../turn-loader.js';
import type { DirectiveProposalType } from '../directive-schema.js';

export interface Detector {
  /** Machine-readable detector name (e.g. "repeated-bash-failure"). */
  name: string;
  /** Human-readable description (shown in docs/logs). */
  description: string;
  /** Analyze all turns and emit proposals. MUST NOT throw. */
  detect(turns: TurnData[]): DirectiveProposalType[];
}

/** A proposal built by a detector that may have fewer than 3 sessions.
 *  The framework uses the schema to enforce the threshold — detectors
 *  may report "candidate" patterns (<3 sessions) separately. */
export interface CandidateSummary {
  detector: string;
  pattern: string;
  session_count: number;
}
