/**
 * Exact marker strings for the auto-sop managed section in CLAUDE.md.
 * These are literal byte strings — NO regex, NO permissiveness.
 *
 * Legacy claude-sop markers are also detected for backward compatibility
 * with existing managed sections written before the rename.
 */

export const BEGIN_MARKER = '<!-- auto-sop:managed-section:begin v1 -->';

export const GENERATED_COMMENT = '<!-- GENERATED - DO NOT EDIT. auto-sop owns this section. -->';

export const END_MARKER = '<!-- auto-sop:managed-section:end -->';

/** Legacy markers from before the claude-sop → auto-sop rename. */
export const LEGACY_BEGIN_MARKER = '<!-- claude-sop:managed-section:begin v1 -->';
export const LEGACY_END_MARKER = '<!-- claude-sop:managed-section:end -->';

export const CLAUDE_MD_HEADER = '# CLAUDE.md\n\n_Project-level instructions for Claude Code._\n';

/** Build the full managed section block from a body string. */
export function buildSectionBlock(body: string): string {
  return [BEGIN_MARKER, GENERATED_COMMENT, '', body, '', END_MARKER].join('\n');
}

export interface MarkerLocation {
  /** Byte offset where the begin marker line starts. */
  beginStart: number;
  /** Byte offset immediately after the end marker line (including its trailing newline if present). */
  endAfter: number;
}

/**
 * Find the managed section markers in file content by exact string match.
 * Checks for new (auto-sop) markers first, then falls back to legacy (claude-sop) markers.
 * Returns null if no markers found.
 * Throws AmbiguousMarkersError if duplicated.
 * Throws MalformedMarkersError if begin present but end missing (or vice-versa).
 */
export function findMarkers(content: string): MarkerLocation | null {
  // Try new markers first
  const result = findMarkersWithPair(content, BEGIN_MARKER, END_MARKER);
  if (result !== null) return result;

  // Fall back to legacy markers
  return findMarkersWithPair(content, LEGACY_BEGIN_MARKER, LEGACY_END_MARKER);
}

function findMarkersWithPair(
  content: string,
  beginMarker: string,
  endMarker: string,
): MarkerLocation | null {
  const beginIdx = content.indexOf(beginMarker);
  if (beginIdx === -1) {
    // No begin marker — check for orphaned end marker
    if (content.indexOf(endMarker) !== -1) {
      throw new MalformedMarkersError('Found end marker without matching begin marker');
    }
    return null;
  }

  // Check for duplicate begin markers
  const secondBegin = content.indexOf(beginMarker, beginIdx + beginMarker.length);
  if (secondBegin !== -1) {
    throw new AmbiguousMarkersError('Multiple begin markers found in CLAUDE.md');
  }

  const endIdx = content.indexOf(endMarker, beginIdx);
  if (endIdx === -1) {
    throw new MalformedMarkersError('Found begin marker without matching end marker');
  }

  // Check for duplicate end markers
  const secondEnd = content.indexOf(endMarker, endIdx + endMarker.length);
  if (secondEnd !== -1) {
    throw new AmbiguousMarkersError('Multiple end markers found in CLAUDE.md');
  }

  // endAfter includes the end marker itself, plus trailing newline if present
  let endAfter = endIdx + endMarker.length;
  if (content[endAfter] === '\n') {
    endAfter += 1;
  }

  return { beginStart: beginIdx, endAfter };
}

// ─── Error classes ───────────────────────────────────────

export class AmbiguousMarkersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousMarkersError';
  }
}

export class MalformedMarkersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedMarkersError';
  }
}
