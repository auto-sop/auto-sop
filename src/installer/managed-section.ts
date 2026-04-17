import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../atomic/write.js';

/**
 * Legacy claude-sop managed-section markers.
 *
 * Retained ONLY for backward-compatible cleanup on uninstall. These markers
 * are no longer written by the installer — v10+ uses ManagedSectionEditor
 * (`src/managed-section/editor.ts`) with `<!-- claude-sop:managed-section:begin v1 -->`
 * markers, which the learner owns exclusively. The installer does not touch
 * CLAUDE.md content anymore.
 */
export const MANAGED_BEGIN = '<!-- claude-sop:begin -->';
export const MANAGED_END = '<!-- claude-sop:end -->';

/**
 * Strip legacy managed-section markers and content between them from CLAUDE.md.
 * Returns the content that was between the markers (for backup), or null if no
 * markers found. Used by uninstall to clean up residue from pre-v15 installs.
 */
export async function stripManagedSection(
  claudeMdPath: string,
): Promise<{ removed: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(claudeMdPath, 'utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { removed: null };
    throw e;
  }

  const beginIdx = text.indexOf(MANAGED_BEGIN);
  const endIdx = text.indexOf(MANAGED_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx)
    return { removed: null };

  const afterEnd = endIdx + MANAGED_END.length;
  const removed = text.slice(beginIdx + MANAGED_BEGIN.length, endIdx);

  // Strip the markers and everything between them, preserving surrounding content.
  // Remove at most one newline directly after MANAGED_END (the line break closing the marker line)
  const trailingNewline = text[afterEnd] === '\n' ? 1 : 0;
  let next = text.slice(0, beginIdx) + text.slice(afterEnd + trailingNewline);
  // Collapse excessive trailing blank lines the separator may have left
  next = next.replace(/\n\n+$/, '\n');

  await writeFileAtomic(claudeMdPath, next);
  return { removed };
}
