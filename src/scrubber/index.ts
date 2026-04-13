/**
 * Public scrubber facade.
 * Re-exports the Scrubber class, factory, rule loader, and all primitive types.
 */
export { Scrubber, createScrubber, type ScrubberOptions } from './scrubber.js';
export { loadRulePack, rulePackSchema } from './yaml-loader.js';
export type { Rule, RulePack, ScrubInput, ScrubResult } from './types.js';
export { sha4, formatRedaction } from './redaction.js';
export { shannonEntropy, ENTROPY_THRESHOLD, MIN_TOKEN_LEN } from './entropy.js';
