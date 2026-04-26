export { extractTokenSavings, computePerDirectiveTokenDelta } from './token-extractor.js';
export type { TokenExtractionResult, TokenDelta } from './token-extractor.js';

export { computeErrorPreventionMetrics, countPreventedSince } from './error-prevention.js';
export type { ErrorPreventionMetrics } from './error-prevention.js';

export { calculateTimeSavings, computePerDirectiveTimeSavings } from './time-savings.js';
export type { TimeSavingsResult, PerDirectiveTimeSavings } from './time-savings.js';

export { aggregateMetrics, toMetricsState } from './aggregator.js';
export type { AggregateMetricsInput, AggregatedMetrics } from './aggregator.js';

export {
  loadMetricsState,
  saveMetricsState,
  emptyMetricsState,
  projectHash,
  metricsStatePath,
} from './state.js';
export type { MetricsState, DirectiveAttribution } from './state.js';

export { toCloudSyncFormat, isValidSyncPayload } from './sync-format.js';
export type { CloudSyncPayload } from './sync-format.js';
