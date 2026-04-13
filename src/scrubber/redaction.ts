/**
 * Redaction formatter.
 * Produces deterministic `[REDACTED:XXXX]` tags where XXXX is the first
 * 4 hex chars of SHA-256(original). Same secret → same tag, always.
 */
import { createHash } from 'node:crypto';

/** First 4 hex chars of SHA-256(secret). */
export function sha4(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 4);
}

/** Format a redaction tag: `[REDACTED:<sha4>]`. */
export function formatRedaction(secret: string): string {
  return `[REDACTED:${sha4(secret)}]`;
}
