/**
 * Exact marker strings for the claude-sop managed section in CLAUDE.md.
 * These are literal byte strings — NO regex, NO permissiveness.
 * Changing these breaks idempotency for all existing managed sections.
 */

export const BEGIN_MARKER =
  '<!-- claude-sop:managed-section:begin v1 -->';

export const GENERATED_COMMENT =
  '<!-- GENERATED - DO NOT EDIT. claude-sop owns this section. -->';

export const END_MARKER = '<!-- claude-sop:managed-section:end -->';

export const CLAUDE_MD_HEADER =
  '# CLAUDE.md\n\n_Project-level instructions for Claude Code._\n';

/** Build the full managed section block from a body string. */
export function buildSectionBlock(body: string): string {
  return [
    BEGIN_MARKER,
    GENERATED_COMMENT,
    '',
    body,
    '',
    END_MARKER,
  ].join('\n');
}

export interface MarkerLocation {
  /** Byte offset where the begin marker line starts. */
  beginStart: number;
  /** Byte offset immediately after the end marker line (including its trailing newline if present). */
  endAfter: number;
}

/**
 * Find the managed section markers in file content by exact string match.
 * Returns null if no markers found.
 * Throws AmbiguousMarkersError if duplicated.
 * Throws MalformedMarkersError if begin present but end missing (or vice-versa).
 */
export function findMarkers(content: string): MarkerLocation | null {
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) {
    // No begin marker — check for orphaned end marker
    if (content.indexOf(END_MARKER) !== -1) {
      throw new MalformedMarkersError(
        'Found end marker without matching begin marker',
      );
    }
    return null;
  }

  // Check for duplicate begin markers
  const secondBegin = content.indexOf(BEGIN_MARKER, beginIdx + BEGIN_MARKER.length);
  if (secondBegin !== -1) {
    throw new AmbiguousMarkersError(
      'Multiple begin markers found in CLAUDE.md',
    );
  }

  const endIdx = content.indexOf(END_MARKER, beginIdx);
  if (endIdx === -1) {
    throw new MalformedMarkersError(
      'Found begin marker without matching end marker',
    );
  }

  // Check for duplicate end markers
  const secondEnd = content.indexOf(END_MARKER, endIdx + END_MARKER.length);
  if (secondEnd !== -1) {
    throw new AmbiguousMarkersError(
      'Multiple end markers found in CLAUDE.md',
    );
  }

  // endAfter includes the end marker itself, plus trailing newline if present
  let endAfter = endIdx + END_MARKER.length;
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
