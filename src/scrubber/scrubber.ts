/**
 * Scrubber — facade composing the 4-stage pipeline.
 *
 * Stage 1: Path exclusion (sensitive file paths short-circuit)
 * Stage 2: Regex pipeline (baseline + user rules)
 * Stage 3: Entropy catch-all (high-entropy tokens that survived regex)
 * Stage 4: Redaction formatting (already applied by stages 2 & 3)
 *
 * BASELINE_YAML is imported as a module constant from baseline.generated.ts.
 * Zero filesystem reads needed for the baseline — no __dirname, no import.meta.url.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { RulePack, ScrubInput, ScrubResult } from './types.js';
import { rulePackSchema, loadRulePack } from './yaml-loader.js';
import { applyPathExclusion } from './path-exclusion.js';
import { applyRegexPipeline } from './regex-pipeline.js';
import { applyEntropyCatchAll, ENTROPY_THRESHOLD, MIN_TOKEN_LEN } from './entropy.js';
import { BASELINE_YAML } from './baseline.generated.js';

export interface ScrubberOptions {
  baselinePack: RulePack;
  userPacks?: RulePack[];
  entropyThreshold?: number;
  minTokenLen?: number;
}

export class Scrubber {
  private readonly rules;
  private readonly entropyThreshold: number;
  private readonly minTokenLen: number;

  constructor(opts: ScrubberOptions) {
    this.rules = [...opts.baselinePack.rules, ...(opts.userPacks ?? []).flatMap((p) => p.rules)];
    this.entropyThreshold = opts.entropyThreshold ?? ENTROPY_THRESHOLD;
    this.minTokenLen = opts.minTokenLen ?? MIN_TOKEN_LEN;
  }

  scrub(input: ScrubInput): ScrubResult {
    // Stage 1: Path exclusion
    const path = applyPathExclusion(input.payload, input.filePath);
    if (path.redacted) {
      return { scrubbed: path.output, redactionsApplied: 1, pathExcluded: true };
    }

    // Stage 2: Regex pipeline (baseline + user rules)
    const regexed = applyRegexPipeline(path.output, this.rules);

    // Stage 3: Entropy catch-all for remaining high-entropy tokens
    const entropic = applyEntropyCatchAll(regexed.output, this.entropyThreshold, this.minTokenLen);

    // Stage 4: Redaction formatting is already applied by stages 2 & 3
    return {
      scrubbed: entropic.output,
      redactionsApplied: regexed.replaced + entropic.replaced,
      pathExcluded: false,
    };
  }
}

/** Parse the embedded baseline YAML into a validated RulePack. */
function parseBaseline(): RulePack {
  const doc: unknown = parse(BASELINE_YAML);
  return rulePackSchema.parse(doc);
}

/**
 * Create a Scrubber with baseline rules and optional user override packs.
 * User packs from `userRulesDir` are loaded alphabetically and merged on top
 * of the baseline without mutating baseline rules.
 */
export async function createScrubber(opts?: { userRulesDir?: string }): Promise<Scrubber> {
  const baseline = parseBaseline();
  const userPacks: RulePack[] = [];

  if (opts?.userRulesDir) {
    try {
      const entries = await fs.readdir(opts.userRulesDir);
      for (const entry of entries.sort()) {
        if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          userPacks.push(await loadRulePack(join(opts.userRulesDir, entry)));
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Missing userRulesDir is not an error — baseline-only mode.
    }
  }

  return new Scrubber({ baselinePack: baseline, userPacks });
}
