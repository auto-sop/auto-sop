export {
  writeManagedSection,
  readManagedSection,
  removeManagedSection,
  renderManagedSection,
  AmbiguousMarkersError,
  MalformedMarkersError,
} from './editor.js';

export type {
  ManagedSectionContent,
  WriteResult,
  WriteOptions,
  ManagedSectionLogger,
} from './editor.js';

export {
  BEGIN_MARKER,
  GENERATED_COMMENT,
  END_MARKER,
  CLAUDE_MD_HEADER,
  buildSectionBlock,
  findMarkers,
} from './markers.js';

export type { MarkerLocation } from './markers.js';

// E1 — hash store for drift detection
export { readLastHash, writeLastHash, clearLastHash, sha256 } from './hash-store.js';

export type { HashRecord } from './hash-store.js';

// E2 — git-state detector
export { isGitBusy } from './git-state.js';

// E5 — directive history, TTL, cap
export {
  loadHistory,
  saveHistory,
  emptyHistory,
  updateFromProposals,
  applyTTLAndCap,
  applyDirectiveHistory,
  getDirectiveConfig,
  DEFAULT_TTL_DAYS,
  DEFAULT_MAX_DIRECTIVES,
  ENV_TTL_DAYS,
  ENV_MAX_DIRECTIVES,
} from './directive-history.js';

export type {
  DirectiveHistory,
  DirectiveHistoryEntry,
  DirectiveSeverity,
  DirectiveProposalLike,
  ApplyTTLAndCapResult,
  DirectiveConfig,
} from './directive-history.js';
