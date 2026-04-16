/**
 * Proposal Merger — combines rule-based detector output with LLM-generated
 * proposals, deduplicating by `id` (LLM version wins because it carries
 * richer, context-aware `rule_text`).
 *
 * Determinism invariant:
 *   Given the same two input arrays, this function returns a byte-identical
 *   result every time. The managed-section editor relies on this to
 *   produce `verdict='unchanged'` on repeat ticks where nothing has really
 *   changed.
 *
 * Sort order (applied AFTER deduplication):
 *   1. severity — error (0) > warning (1) > info (2)
 *   2. created_at — ascending (older first)
 *   3. id — ascending (lexicographic tiebreaker, for determinism)
 *
 * Cap:
 *   Hard-capped at 10 directives total. Because the sort puts the highest
 *   severity first, slicing to 10 naturally drops the lowest-severity
 *   directives first, which is the behaviour we want.
 */
import type { DirectiveProposalType } from './directive-schema.js';

// ── Constants ──────────────────────────────────────────────

/** Maximum number of directives that may appear in CLAUDE.md at once. */
export const MAX_DIRECTIVES = 10;

const SEVERITY_RANK: Record<DirectiveProposalType['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ── Public API ─────────────────────────────────────────────

/**
 * Merge rule-based and LLM-generated directive proposals.
 *
 * - Combines both arrays.
 * - Deduplicates by `id` — if the same id exists in both, the LLM version
 *   wins (LLM output typically has more natural-language context).
 * - Sorts by (severity desc, created_at asc, id asc).
 * - Caps the result at {@link MAX_DIRECTIVES} entries; because sort pushes
 *   higher severities to the front, the cap drops the lowest-severity
 *   items first.
 *
 * Pure function. Does not mutate its inputs. Returns a new array.
 */
export function mergeProposals(
  ruleProposals: DirectiveProposalType[],
  llmProposals: DirectiveProposalType[],
): DirectiveProposalType[] {
  // Seed the map with rule-based proposals, then overlay LLM proposals so
  // duplicate ids end up holding the LLM version. Using a Map preserves
  // the semantic "last writer wins" without needing a separate dedup pass.
  const byId = new Map<string, DirectiveProposalType>();
  for (const p of ruleProposals) {
    byId.set(p.id, p);
  }
  for (const p of llmProposals) {
    byId.set(p.id, p);
  }

  const merged = Array.from(byId.values()).sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const tsDiff = a.created_at.localeCompare(b.created_at);
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });

  if (merged.length > MAX_DIRECTIVES) {
    return merged.slice(0, MAX_DIRECTIVES);
  }
  return merged;
}
