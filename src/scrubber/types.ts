/**
 * Scrubber primitive types.
 * Consumed by yaml-loader, path-exclusion, entropy, redaction, and the pipeline (05b).
 */

/** A single scrubbing rule loaded from a YAML rule pack. */
export interface Rule {
  id: string;
  description: string;
  /** Regex source string — must compile via `new RegExp(pattern, flags)`. */
  pattern: string;
  /** Regex flags. Defaults to `'g'` when omitted. */
  flags?: string | undefined;
  /** Optional custom replacement template (e.g. keeps env-var key name). */
  replacement?: string | undefined;
}

/** A versioned collection of scrubbing rules. */
export interface RulePack {
  version: 1;
  rules: Rule[];
}

/** Input to the scrubber pipeline. */
export interface ScrubInput {
  payload: string;
  /** Optional tool_input.file_path — used by the path-exclusion stage. */
  filePath?: string | undefined;
}

/** Result returned by the scrubber pipeline. */
export interface ScrubResult {
  scrubbed: string;
  redactionsApplied: number;
  pathExcluded: boolean;
}
