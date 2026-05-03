/**
 * Pure JS unified diff — LCS-based, no external diff binary.
 * Produces a unified-diff-style string with configurable context lines.
 */

// ── LCS (Longest Common Subsequence on lines) ──────────────

/**
 * Compute LCS table for two arrays of lines.
 * Returns a 2D array where table[i][j] = length of LCS of a[0..i-1] and b[0..j-1].
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i]![j] = table[i - 1]![j - 1]! + 1;
      } else {
        table[i]![j] = Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
      }
    }
  }
  return table;
}

/** A single diff edit operation. */
export interface DiffEdit {
  type: 'equal' | 'insert' | 'delete';
  line: string;
  /** 1-based line number in the "old" (a) file — undefined for inserts. */
  oldLineNo?: number;
  /** 1-based line number in the "new" (b) file — undefined for deletes. */
  newLineNo?: number;
}

/**
 * Backtrack the LCS table to produce a sequence of edit operations.
 */
function backtrackEdits(table: number[][], a: string[], b: string[]): DiffEdit[] {
  const edits: DiffEdit[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.push({ type: 'equal', line: a[i - 1]!, oldLineNo: i, newLineNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i]![j - 1]! >= table[i - 1]![j]!)) {
      edits.push({ type: 'insert', line: b[j - 1]!, newLineNo: j });
      j--;
    } else {
      edits.push({ type: 'delete', line: a[i - 1]!, oldLineNo: i });
      i--;
    }
  }

  return edits.reverse();
}

// ── Unified diff output ─────────────────────────────────────

export interface UnifiedDiffOptions {
  oldLabel?: string;
  newLabel?: string;
  context?: number;
}

/**
 * Produce a unified-diff-style string from two texts.
 * Pure JS — no external binary.
 *
 * @param oldText - The original file content
 * @param newText - The proposed new content
 * @param opts    - Labels and context line count (default 3)
 * @returns Unified diff string, or empty string if identical
 */
export function unifiedDiff(oldText: string, newText: string, opts?: UnifiedDiffOptions): string {
  if (oldText === newText) return '';

  const contextLines = opts?.context ?? 3;
  const oldLabel = opts?.oldLabel ?? 'a';
  const newLabel = opts?.newLabel ?? 'b';

  const aLines = oldText.split('\n');
  const bLines = newText.split('\n');

  const table = lcsTable(aLines, bLines);
  const edits = backtrackEdits(table, aLines, bLines);

  // Group edits into hunks separated by more than `contextLines` equal lines
  const hunks = groupHunks(edits, contextLines);

  if (hunks.length === 0) return '';

  const header = `--- ${oldLabel}\n+++ ${newLabel}\n`;
  const hunkTexts = hunks.map((hunk) => formatHunk(hunk));

  return header + hunkTexts.join('');
}

interface Hunk {
  edits: DiffEdit[];
}

/**
 * Group edits into hunks. A new hunk starts when there are more than
 * 2*context consecutive equal lines between changes.
 */
function groupHunks(edits: DiffEdit[], context: number): Hunk[] {
  // Find ranges of non-equal edits
  const changeRanges: Array<[number, number]> = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.type !== 'equal') {
      const start = i;
      while (i < edits.length && edits[i]!.type !== 'equal') {
        i++;
      }
      changeRanges.push([start, i - 1]);
    }
  }

  if (changeRanges.length === 0) return [];

  // Merge nearby change ranges into hunks
  const hunks: Hunk[] = [];
  let currentStart = Math.max(0, changeRanges[0]![0] - context);
  let currentEnd = Math.min(edits.length - 1, changeRanges[0]![1] + context);

  for (let r = 1; r < changeRanges.length; r++) {
    const rangeStart = changeRanges[r]![0];
    const rangeEnd = changeRanges[r]![1];

    // If the gap between current hunk end and next range start is <= 2*context, merge
    if (rangeStart - currentEnd <= 2 * context) {
      currentEnd = Math.min(edits.length - 1, rangeEnd + context);
    } else {
      hunks.push({ edits: edits.slice(currentStart, currentEnd + 1) });
      currentStart = Math.max(0, rangeStart - context);
      currentEnd = Math.min(edits.length - 1, rangeEnd + context);
    }
  }
  hunks.push({ edits: edits.slice(currentStart, currentEnd + 1) });

  return hunks;
}

function formatHunk(hunk: Hunk): string {
  const { edits } = hunk;
  if (edits.length === 0) return '';

  // Compute old/new line ranges
  let oldStart = Infinity;
  let oldCount = 0;
  let newStart = Infinity;
  let newCount = 0;

  for (const edit of edits) {
    if (edit.type === 'equal' || edit.type === 'delete') {
      if (edit.oldLineNo !== undefined && edit.oldLineNo < oldStart) {
        oldStart = edit.oldLineNo;
      }
      oldCount++;
    }
    if (edit.type === 'equal' || edit.type === 'insert') {
      if (edit.newLineNo !== undefined && edit.newLineNo < newStart) {
        newStart = edit.newLineNo;
      }
      newCount++;
    }
  }

  if (oldStart === Infinity) oldStart = 1;
  if (newStart === Infinity) newStart = 1;

  const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
  const lines = edits.map((edit) => {
    switch (edit.type) {
      case 'equal':
        return ` ${edit.line}`;
      case 'insert':
        return `+${edit.line}`;
      case 'delete':
        return `-${edit.line}`;
    }
  });

  return hunkHeader + lines.join('\n') + '\n';
}
