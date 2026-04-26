/**
 * Proposal Merger — combines rule-based detector output with LLM-generated
 * proposals.
 *
 * Two deduplication layers run in order:
 *
 *   1. By `id` — identical ids from the rule and LLM streams collapse to
 *      one entry, with the LLM version winning because it carries richer,
 *      context-aware `rule_text`.
 *
 *   2. By semantic fingerprint — two proposals that express the same rule
 *      with different ids (for example, a rule-based detector and the LLM
 *      independently discovering the same pattern) collapse to one entry.
 *      Fingerprint = normalized rule_text + ':' + severity, where
 *      normalized = lowercased, whitespace-collapsed, trimmed, first 100
 *      chars. Among duplicates the winner is chosen by:
 *        (a) evidence.session_ids.length DESC — most-witnessed wins;
 *        (b) source DESC — LLM-sourced beats rule-based.
 *      (Severity is not a tiebreak here — it's part of the fingerprint, so
 *       every member of a group shares severity by construction.)
 *      All tiebreakers then fall back to `created_at` asc and `id` asc so
 *      output stays byte-deterministic.
 *
 * Determinism invariant:
 *   Given the same two input arrays, this function returns a byte-identical
 *   result every time. The managed-section editor relies on this to
 *   produce `verdict='unchanged'` on repeat ticks where nothing has really
 *   changed.
 *
 * Final sort order (applied AFTER deduplication):
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
import { deduplicateProposals } from './dedup.js';

// ── Constants ──────────────────────────────────────────────

/** Maximum number of directives that may appear in CLAUDE.md at once. */
export const MAX_DIRECTIVES = 10;

/** Max characters of rule_text that count toward the fingerprint. Capping
 *  prevents a long-tail suffix from defeating dedup when two proposals
 *  start identically but diverge in trailing punctuation. */
const FINGERPRINT_PREFIX_CHARS = 100;

const SEVERITY_RANK: Record<DirectiveProposalType['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

// ── Public types ───────────────────────────────────────────

/**
 * Shape returned by {@link mergeProposalsWithDedup}. Callers that only
 * want the final directive list can use the thin {@link mergeProposals}
 * wrapper which returns the array directly.
 */
export interface MergeResult {
  /** Sorted, capped set of directives to render into the managed section. */
  proposals: DirectiveProposalType[];
  /**
   * Number of proposals dropped by the semantic-fingerprint pass (i.e. the
   * total count of losers across all duplicate groups). Does NOT include
   * id-based dedup losses or items dropped by the MAX_DIRECTIVES cap.
   * Surfaced in per-project recap as `merge_deduped_count`.
   */
  dedupedCount: number;
  /**
   * Number of proposals skipped by near-duplicate bigram detection.
   * These were too similar (Dice > 0.6) to an existing accepted proposal.
   */
  nearDuplicateSkipped: number;
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Canonicalize a rule_text for fingerprinting.
 *   - lowercase
 *   - collapse runs of whitespace (including newlines) to single space
 *   - trim leading/trailing whitespace
 *   - truncate to FINGERPRINT_PREFIX_CHARS
 */
function normalizeRuleText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, FINGERPRINT_PREFIX_CHARS);
}

/**
 * Semantic fingerprint for duplicate detection. Two proposals with the
 * same fingerprint express the same rule at the same severity level.
 */
function semanticFingerprint(p: DirectiveProposalType): string {
  return normalizeRuleText(p.rule_text) + ':' + p.severity;
}

/**
 * Whether a proposal came from the LLM pipeline. The LLM proposer sets
 * `detector: 'llm'` (or a name starting with 'llm-', e.g. 'llm-analysis')
 * whereas rule-based detectors use pattern-specific names like
 * 'repeated-bash-failure'. This heuristic preserves the tiebreak contract
 * "LLM-sourced beats rule-based" without requiring a schema change.
 */
function isLlmSource(p: DirectiveProposalType): boolean {
  const d = p.detector;
  // Note: 'llm-analysis' is not listed explicitly — it's already covered by
  // the startsWith('llm-') check. Keeping the two predicates redundant-free
  // avoids a dead branch and a lint warning.
  return d === 'llm' || d.startsWith('llm-');
}

// ── Public API ─────────────────────────────────────────────

/**
 * Merge rule-based and LLM-generated directive proposals.
 *
 * Thin wrapper over {@link mergeProposalsWithDedup} that returns only the
 * final proposal array. Use the richer entry point when you also need the
 * dedup count (e.g. to surface it in a recap).
 */
export function mergeProposals(
  ruleProposals: DirectiveProposalType[],
  llmProposals: DirectiveProposalType[],
): DirectiveProposalType[] {
  return mergeProposalsWithDedup(ruleProposals, llmProposals).proposals;
}

/**
 * Full merge pipeline. Returns both the final proposals and the count of
 * items dropped by the semantic-fingerprint dedup pass so the caller can
 * record it in the per-project recap (`merge_deduped_count`).
 *
 * @param existingRuleTexts - Optional list of rule_text strings from
 *   already-active directives. When provided, new proposals are checked
 *   against these using bigram Dice similarity (threshold 0.6) and
 *   near-duplicates are dropped before the final sort+cap.
 *
 * Pure function. Does not mutate its inputs.
 */
export function mergeProposalsWithDedup(
  ruleProposals: DirectiveProposalType[],
  llmProposals: DirectiveProposalType[],
  existingRuleTexts?: string[],
): MergeResult {
  // 1. Dedup by id — LLM version wins on collisions.
  const byId = new Map<string, DirectiveProposalType>();
  for (const p of ruleProposals) {
    byId.set(p.id, p);
  }
  for (const p of llmProposals) {
    byId.set(p.id, p);
  }
  const combined = Array.from(byId.values());

  // 2. Dedup by semantic fingerprint.
  //    Group, then pick a winner per group. We retain order-insensitivity
  //    by sorting each group's candidates through the exact same total
  //    order so the winner is stable regardless of the input ordering.
  const groups = new Map<string, DirectiveProposalType[]>();
  for (const p of combined) {
    const fp = semanticFingerprint(p);
    let bucket = groups.get(fp);
    if (bucket === undefined) {
      bucket = [];
      groups.set(fp, bucket);
    }
    bucket.push(p);
  }

  let dedupedCount = 0;
  const winners: DirectiveProposalType[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      winners.push(bucket[0]!);
      continue;
    }
    // Total order for tiebreaking within a duplicate group:
    //   (1) evidence.session_ids.length DESC  — most evidence wins
    //   (2) source                            — LLM > rule
    //   (3) created_at ASC                    — deterministic
    //   (4) id ASC                            — deterministic tiebreaker
    //
    // Note: no severity tiebreak — fingerprint includes severity, so all
    // members of a group share severity by construction.
    const sorted = [...bucket].sort((a, b) => {
      const evDiff = b.evidence.session_ids.length - a.evidence.session_ids.length;
      if (evDiff !== 0) return evDiff;
      const aLlm = isLlmSource(a) ? 1 : 0;
      const bLlm = isLlmSource(b) ? 1 : 0;
      if (aLlm !== bLlm) return bLlm - aLlm;
      const tsDiff = a.created_at.localeCompare(b.created_at);
      if (tsDiff !== 0) return tsDiff;
      return a.id.localeCompare(b.id);
    });
    winners.push(sorted[0]!);
    dedupedCount += bucket.length - 1;
  }

  // 3. Near-duplicate detection via bigram Dice similarity.
  //    When existingRuleTexts are provided, filter out new proposals that
  //    are too similar to already-active directives. This prevents the
  //    managed section from accumulating semantically-redundant entries.
  let afterDedup = winners;
  let nearDuplicateSkipped = 0;
  if (existingRuleTexts !== undefined && existingRuleTexts.length > 0) {
    const dedupResult = deduplicateProposals(winners, existingRuleTexts);
    afterDedup = dedupResult.accepted;
    nearDuplicateSkipped = dedupResult.skippedCount;
  }

  // 4. Final sort and cap.
  const finalSorted = afterDedup.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const tsDiff = a.created_at.localeCompare(b.created_at);
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });

  const proposals =
    finalSorted.length > MAX_DIRECTIVES ? finalSorted.slice(0, MAX_DIRECTIVES) : finalSorted;

  return { proposals, dedupedCount, nearDuplicateSkipped };
}
