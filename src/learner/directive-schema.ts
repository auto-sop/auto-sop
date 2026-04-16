/**
 * Directive Proposal Schema — Zod-strict validation for detector output.
 *
 * Enforces contract at the schema layer so a detector bug cannot emit
 * a malformed directive that reaches CLAUDE.md:
 *
 * - session_ids.min(3)      → N=3 threshold enforced by schema
 * - rule_text 10..500 chars → prevents bloat/empty directives (also
 *                             limits the impact of any injection-via-
 *                             detector-bug into the managed section)
 * - id regex /^[a-z0-9-]+$/ → deterministic, safe identifier
 *
 * generateProposalId(detector, pattern) uses sha256 truncated to 12 hex
 * chars, then prefixes with the detector name. Same (detector, pattern)
 * input always produces the same id (enables duplicate detection).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

// ── Schema ─────────────────────────────────────────────────

export const DirectiveProposal = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric + dashes'),
  detector: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  rule_text: z
    .string()
    .min(10, 'rule_text must be at least 10 chars')
    .max(500, 'rule_text must be at most 500 chars'),
  evidence: z.object({
    session_ids: z.array(z.string().min(1)).min(3, 'at least 3 distinct sessions required'),
    turn_ids: z.array(z.string().min(1)).min(1),
    pattern: z.string().min(1),
    occurrence_count: z.number().int().min(3),
    first_seen: z.string().min(1),
  }),
  created_at: z.string().min(1),
});

export type DirectiveProposalType = z.infer<typeof DirectiveProposal>;

// ── ID generator ───────────────────────────────────────────

/**
 * Deterministic proposal ID.
 *
 * Produces a value matching /^[a-z0-9-]+$/ — a sanitized detector name
 * followed by a 12-hex-char sha256 hash of the pattern. Same inputs
 * always produce the same id.
 *
 * Safety: the pattern input is a free-form string (e.g. a Bash command
 * fingerprint) that may contain attacker-influenced content. We hash it,
 * not interpolate it, so no captured content ever reaches the id field.
 */
export function generateProposalId(detector: string, pattern: string): string {
  const hash = createHash('sha256')
    .update(`${detector}\u0000${pattern}`)
    .digest('hex')
    .slice(0, 12);
  const safeDetector = detector
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const prefix = safeDetector.length > 0 ? safeDetector : 'det';
  return `${prefix}-${hash}`;
}
