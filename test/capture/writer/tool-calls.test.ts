import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  appendPreToolLine,
  appendPostToolLine,
  TOOL_CALLS_JSONL,
} from '~/capture/writer/tool-calls.js';
import type { PreToolLine, PostToolLine } from '~/capture/writer/tool-calls.js';
import { createScrubber, Scrubber } from '~/scrubber/index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('tool-calls', () => {
  let turnDir: string;
  let scrubber: Scrubber;

  beforeEach(async () => {
    turnDir = makeTmpDir();
    scrubber = await createScrubber();
  });

  describe('appendPreToolLine', () => {
    it('appends a pre line and creates file with mode 0600', () => {
      const line: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-001',
        tool: 'Read',
        input: { file_path: '/tmp/test.txt' },
        t: new Date().toISOString(),
      };

      appendPreToolLine(turnDir, line, scrubber);

      const jsonlPath = join(turnDir, TOOL_CALLS_JSONL);
      const stat = statSync(jsonlPath);
      expect(stat.mode & 0o777).toBe(0o600);

      const content = readFileSync(jsonlPath, 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.event).toBe('pre');
      expect(parsed.tool_use_id).toBe('tu-001');
      expect(parsed.tool).toBe('Read');
    });

    it('scrubs secrets from tool input; hitCount > 0', () => {
      const line: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-002',
        tool: 'Bash',
        input: {
          command:
            'export AWS_KEY=AKIAIOSFODNN7EXAMPLE1 && export SECRET=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        t: new Date().toISOString(),
      };

      const { hitCount } = appendPreToolLine(turnDir, line, scrubber);

      const content = readFileSync(join(turnDir, TOOL_CALLS_JSONL), 'utf8');
      expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE1');
      expect(content).not.toContain('sk-ant-api03');
      expect(hitCount).toBeGreaterThanOrEqual(1);
    });

    it('handles large input (8KB) without lockfile', () => {
      const line: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-003',
        tool: 'Write',
        input: { content: 'x'.repeat(8000) },
        t: new Date().toISOString(),
      };

      appendPreToolLine(turnDir, line, scrubber);

      const content = readFileSync(join(turnDir, TOOL_CALLS_JSONL), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.event).toBe('pre');
      expect((parsed.input as { content: string }).content).toHaveLength(8000);
    });
  });

  describe('appendPostToolLine', () => {
    it('post line joins on same tool_use_id as pre', () => {
      const toolUseId = 'tu-join-test';
      const preLine: PreToolLine = {
        event: 'pre',
        tool_use_id: toolUseId,
        tool: 'Read',
        input: { file_path: '/tmp/a.txt' },
        t: new Date().toISOString(),
      };
      const postLine: PostToolLine = {
        event: 'post',
        tool_use_id: toolUseId,
        output: 'file contents here',
        success: true,
        t: new Date().toISOString(),
      };

      appendPreToolLine(turnDir, preLine, scrubber);
      appendPostToolLine(turnDir, postLine, scrubber);

      const lines = readFileSync(join(turnDir, TOOL_CALLS_JSONL), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);

      const first = JSON.parse(lines[0]!);
      const second = JSON.parse(lines[1]!);
      expect(first.event).toBe('pre');
      expect(first.tool_use_id).toBe(toolUseId);
      expect(second.event).toBe('post');
      expect(second.tool_use_id).toBe(toolUseId);
    });

    it('scrubs secrets from post output', () => {
      const postLine: PostToolLine = {
        event: 'post',
        tool_use_id: 'tu-sec',
        output: 'Found key: sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        success: true,
        t: new Date().toISOString(),
      };

      const { hitCount } = appendPostToolLine(turnDir, postLine, scrubber);

      const content = readFileSync(join(turnDir, TOOL_CALLS_JSONL), 'utf8');
      expect(content).not.toContain('sk-ant-api03');
      expect(hitCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('broken JSON fallback', () => {
    it('uses fallback when scrubber produces invalid JSON', () => {
      // Create a mock scrubber that returns broken JSON
      const brokenScrubber = {
        scrub: () => ({
          scrubbed: '{"event":',
          redactionsApplied: 1,
          pathExcluded: false,
        }),
      } as unknown as Scrubber;

      const line: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-broken',
        tool: 'Bash',
        input: 'some secret',
        t: new Date().toISOString(),
      };

      appendPreToolLine(turnDir, line, brokenScrubber);

      const content = readFileSync(join(turnDir, TOOL_CALLS_JSONL), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.event).toBe('pre');
      expect(parsed.tool_use_id).toBe('tu-broken');
      expect(parsed.input).toBe('[REDACTION_BROKE_JSON]');
    });
  });

  describe('no proper-lockfile import', () => {
    it('tool-calls.ts does not import proper-lockfile', () => {
      const src = readFileSync(join(process.cwd(), 'src/capture/writer/tool-calls.ts'), 'utf8');
      expect(src).not.toContain('proper-lockfile');
    });
  });
});
