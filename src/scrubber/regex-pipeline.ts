/**
 * Stage 2 — Regex pipeline.
 * Applies rule pack regexes in order, replacing matches with
 * `[REDACTED:<sha4>]` (or rule.replacement when set).
 */
import type { Rule } from './types.js';
import { formatRedaction } from './redaction.js';

export interface RegexMatch {
  match: string;
  ruleId: string;
  start: number;
  end: number;
}

export function applyRegexPipeline(
  input: string,
  rules: Rule[],
): { output: string; replaced: number } {
  let output = input;
  let replaced = 0;

  for (const rule of rules) {
    const re = new RegExp(rule.pattern, rule.flags ?? 'g');

    if (rule.replacement !== undefined) {
      const before = output;
      output = output.replace(re, rule.replacement);
      // Count how many replacements occurred by comparing before/after
      if (before !== output) {
        const matches = before.match(re);
        replaced += matches ? matches.length : 1;
      }
    } else {
      output = output.replace(re, (match) => {
        replaced++;
        return formatRedaction(match);
      });
    }
  }

  return { output, replaced };
}
