/**
 * Entropy catch-all stage (Stage 3).
 * Scans for high-entropy tokens that survived regex-based scrubbing.
 * Uses Shannon entropy with ENTROPY_THRESHOLD = 4.5 per CONTEXT.md decision B.
 */
import { formatRedaction } from './redaction.js';

/** Shannon entropy threshold — tokens at or above this are redacted. */
export const ENTROPY_THRESHOLD = 4.5;

/** Minimum token length to consider for entropy analysis. */
export const MIN_TOKEN_LEN = 20;

/**
 * Calculate the Shannon entropy (bits per character) of a string.
 * Returns 0 for empty strings.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let h = 0;
  const n = s.length;
  for (const count of freq.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Replace high-entropy tokens (≥ `threshold` bits, ≥ `minLen` chars) with
 * `[REDACTED:XXXX]` tags. Returns the scrubbed string and replacement count.
 */
export function applyEntropyCatchAll(
  input: string,
  threshold: number = ENTROPY_THRESHOLD,
  minLen: number = MIN_TOKEN_LEN,
): { output: string; replaced: number } {
  let replaced = 0;
  const output = input.replace(/[A-Za-z0-9+/=_-]{20,}/g, (token) => {
    if (token.length < minLen) return token;
    if (shannonEntropy(token) >= threshold) {
      replaced++;
      return formatRedaction(token);
    }
    return token;
  });
  return { output, replaced };
}
