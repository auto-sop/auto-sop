import type { DirectiveProposalType } from './directive-schema.js';

/** Extract character bigrams from a normalized string. */
function bigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    result.add(normalized.slice(i, i + 2));
  }
  return result;
}

/** Dice coefficient between two bigram sets. Returns 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/** Default similarity threshold — proposals above this are near-duplicates. */
export const DEDUP_THRESHOLD = 0.6;

export interface DedupResult {
  accepted: DirectiveProposalType[];
  skippedCount: number;
}

/**
 * Filter out near-duplicate proposals by comparing each candidate's
 * rule_text against a set of existing active directive rule_texts.
 * Uses bigram Dice coefficient with threshold 0.6 as a fast pre-filter.
 * No LLM calls — pure string similarity.
 */
export function deduplicateProposals(
  candidates: DirectiveProposalType[],
  existingRuleTexts: string[],
  threshold: number = DEDUP_THRESHOLD,
): DedupResult {
  const accepted: DirectiveProposalType[] = [];
  let skippedCount = 0;
  const allTexts = [...existingRuleTexts];

  for (const candidate of candidates) {
    let isDuplicate = false;
    for (const existing of allTexts) {
      if (diceSimilarity(candidate.rule_text, existing) > threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      skippedCount++;
    } else {
      accepted.push(candidate);
      allTexts.push(candidate.rule_text);
    }
  }

  return { accepted, skippedCount };
}
