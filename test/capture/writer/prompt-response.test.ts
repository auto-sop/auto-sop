import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  writePromptMd,
  writeResponseMd,
  extractLastAssistantMessage,
} from '~/capture/writer/prompt-response.js';
import { createScrubber, Scrubber } from '~/scrubber/index.js';
import { isWindows } from '../../setup/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('prompt-response', () => {
  let tmpBase: string;
  let scrubber: Scrubber;

  beforeEach(async () => {
    tmpBase = makeTmpDir();
    scrubber = await createScrubber();
  });

  describe('writePromptMd', () => {
    it('scrubs secrets from prompt before writing', () => {
      const turnDir = join(tmpBase, 'turn-scrub');
      mkdirSync(turnDir, { recursive: true });

      const rawPrompt =
        'My API key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const { hitCount } = writePromptMd(turnDir, rawPrompt, scrubber);

      const written = readFileSync(join(turnDir, 'prompt.md'), 'utf8');
      expect(written).not.toContain('sk-ant-api03');
      expect(hitCount).toBeGreaterThanOrEqual(1);
    });

    it('writes prompt.md with mode 0600', () => {
      const turnDir = join(tmpBase, 'turn-perm');
      mkdirSync(turnDir, { recursive: true });

      writePromptMd(turnDir, 'hello', scrubber);
      const stat = statSync(join(turnDir, 'prompt.md'));
      if (!isWindows) {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('writes via temp+rename (no .tmp remains)', () => {
      const turnDir = join(tmpBase, 'turn-atomic');
      mkdirSync(turnDir, { recursive: true });

      writePromptMd(turnDir, 'test', scrubber);
      const files = readdirSync(turnDir);
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(files).toContain('prompt.md');
    });

    it('returns hitCount 0 for clean text', () => {
      const turnDir = join(tmpBase, 'turn-clean');
      mkdirSync(turnDir, { recursive: true });

      const { hitCount } = writePromptMd(turnDir, 'just a normal prompt', scrubber);
      expect(hitCount).toBe(0);
    });
  });

  describe('writeResponseMd', () => {
    it('scrubs secrets from response', () => {
      const turnDir = join(tmpBase, 'turn-resp');
      mkdirSync(turnDir, { recursive: true });

      const rawResponse =
        'Found key: sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      const { hitCount } = writeResponseMd(turnDir, rawResponse, scrubber);

      const written = readFileSync(join(turnDir, 'response.md'), 'utf8');
      expect(written).not.toContain('sk-ant-api03');
      expect(hitCount).toBeGreaterThanOrEqual(1);
    });

    it('writes response.md with mode 0600', () => {
      const turnDir = join(tmpBase, 'turn-resp-perm');
      mkdirSync(turnDir, { recursive: true });

      writeResponseMd(turnDir, 'response text', scrubber);
      const stat = statSync(join(turnDir, 'response.md'));
      if (!isWindows) {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });
});

describe('extractLastAssistantMessage', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = makeTmpDir();
  });

  it('returns the last assistant message from a JSONL transcript', () => {
    const transcriptPath = join(tmpBase, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'First response' }] },
      }),
      JSON.stringify({
        type: 'human',
        message: { content: [{ type: 'text', text: 'Follow up' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Second response' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Third and final response' }],
        },
      }),
    ];
    writeFileSync(transcriptPath, lines.join('\n'));

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe('Third and final response');
  });

  it('returns empty string for missing file', () => {
    const result = extractLastAssistantMessage('/tmp/nonexistent-transcript-' + Date.now());
    expect(result).toBe('');
  });

  it('returns empty string for empty file', () => {
    const transcriptPath = join(tmpBase, 'empty.jsonl');
    writeFileSync(transcriptPath, '');

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe('');
  });

  it('returns empty string for malformed lines', () => {
    const transcriptPath = join(tmpBase, 'bad.jsonl');
    writeFileSync(transcriptPath, 'not json\nalso not json\n');

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe('');
  });

  it('skips malformed lines but finds valid assistant messages', () => {
    const transcriptPath = join(tmpBase, 'mixed.jsonl');
    const lines = [
      'not json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Valid response' }] },
      }),
      'also bad',
    ];
    writeFileSync(transcriptPath, lines.join('\n'));

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe('Valid response');
  });

  it('handles multi-part content (joins text parts)', () => {
    const transcriptPath = join(tmpBase, 'multi.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
          { type: 'text', text: 'Part 2' },
        ],
      },
    });
    writeFileSync(transcriptPath, line);

    const result = extractLastAssistantMessage(transcriptPath);
    expect(result).toBe('Part 1\nPart 2');
  });
});
