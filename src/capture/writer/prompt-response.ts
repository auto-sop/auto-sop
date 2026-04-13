/**
 * Scrub and atomically write prompt.md / response.md into a turn directory.
 * Phase 0 Scrubber runs BEFORE any disk write (PRIV-01).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scrubber } from '../../scrubber/index.js';
import { atomicWriteFile } from './atomic-io.js';

/**
 * Scrub and write prompt.md. Returns the scrubber hit count.
 */
export function writePromptMd(
  turnDir: string,
  rawPromptText: string,
  scrubber: Scrubber,
): { hitCount: number } {
  const result = scrubber.scrub({ payload: rawPromptText });
  atomicWriteFile(join(turnDir, 'prompt.md'), result.scrubbed);
  return { hitCount: result.redactionsApplied };
}

/**
 * Scrub and write response.md. Returns the scrubber hit count.
 */
export function writeResponseMd(
  turnDir: string,
  rawResponseText: string,
  scrubber: Scrubber,
): { hitCount: number } {
  const result = scrubber.scrub({ payload: rawResponseText });
  atomicWriteFile(join(turnDir, 'response.md'), result.scrubbed);
  return { hitCount: result.redactionsApplied };
}

/**
 * Extract the last assistant message from a Claude Code JSONL transcript.
 * Returns empty string on missing file, empty file, or malformed lines.
 */
export function extractLastAssistantMessage(transcriptPath: string): string {
  try {
    const raw = readFileSync(transcriptPath, 'utf8').trim();
    if (!raw) return '';

    const lines = raw.split('\n');
    let lastMessage = '';

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === 'assistant') {
          // Claude Code transcript format: { type: 'assistant', message: { content: [{text: '...'}] } }
          const message = entry.message as Record<string, unknown> | undefined;
          if (message) {
            const content = message.content as Array<{ type?: string; text?: string }> | undefined;
            if (Array.isArray(content)) {
              const textParts = content
                .filter((c) => c.type === 'text' && typeof c.text === 'string')
                .map((c) => c.text!);
              if (textParts.length > 0) {
                lastMessage = textParts.join('\n');
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return lastMessage;
  } catch {
    return '';
  }
}
