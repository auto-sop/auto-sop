export {
  writeManagedSection,
  readManagedSection,
  removeManagedSection,
  AmbiguousMarkersError,
  MalformedMarkersError,
} from './editor.js';

export type {
  ManagedSectionContent,
  WriteResult,
  WriteOptions,
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
