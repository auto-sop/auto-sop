/**
 * Detector registry.
 *
 * Adding a new detector is a single-file change in `detectors/` plus
 * an entry here. Zero framework changes required.
 */
import type { Detector } from './types.js';
import { repeatedBashFailureDetector } from './repeated-bash-failure.js';
import { repeatedEditFailDetector } from './repeated-edit-fail.js';

export { repeatedBashFailureDetector } from './repeated-bash-failure.js';
export { repeatedEditFailDetector } from './repeated-edit-fail.js';
export type { Detector, CandidateSummary } from './types.js';

export { countBashFailureCandidates } from './repeated-bash-failure.js';
export { countEditFailureCandidates } from './repeated-edit-fail.js';

/** All registered detectors, in execution order. */
export const detectors: Detector[] = [repeatedBashFailureDetector, repeatedEditFailDetector];
