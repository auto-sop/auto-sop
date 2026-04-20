/**
 * Integration-level tests: full UserPromptSubmit → Stop lifecycle.
 * Tests the handlers directly (no subprocess) to verify the complete flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { handleUserPromptSubmit, handleStop } from '~/capture/writer/routes/main-thread-route.js';
import { readMeta } from '~/capture/writer/meta.js';
import { resolveCurrentTurn } from '~/capture/writer/session-state.js';
import { createScrubber } from '~/scrubber/index.js';
import type { HandlerContext } from '~/capture/writer/routes/types.js';
import type { UserPromptSubmitPayload, StopPayload } from '~/capture/events.js';
import { getCapturePaths } from '~/capture/paths.js';
import { isWindows } from '../../setup/platform.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `auto-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('UserPromptSubmit → Stop lifecycle', () => {
  let projectRoot: string;
  let ctx: HandlerContext;
  const sessionId = 'test-session-' + randomUUID().slice(0, 8);

  beforeEach(async () => {
    projectRoot = makeTmpDir();
    const projectId = 'testproj1234';
    const paths = getCapturePaths(projectRoot, projectId);

    // Ensure directories exist
    mkdirSync(paths.projectCaptureDir, { recursive: true, mode: 0o700 });
    mkdirSync(paths.projectStateDir, { recursive: true, mode: 0o700 });

    const scrubber = await createScrubber();

    ctx = {
      projectRoot,
      projectId,
      projectSlug: 'test-project',
      paths,
      scrubber,
      hookShimVersion: '0.1.0',
    };
  });

  it('UserPromptSubmit creates .pending dir with prompt.md and meta.json', () => {
    const event: UserPromptSubmitPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: '/tmp/t.jsonl',
      cwd: projectRoot,
      prompt: 'What is the meaning of life?',
    };

    handleUserPromptSubmit(event, ctx);

    // Check .pending dir exists
    const entries = readdirSync(ctx.paths.projectCaptureDir);
    const pendingEntries = entries.filter((e) => e.endsWith('.pending'));
    expect(pendingEntries).toHaveLength(1);

    const pendingDir = join(ctx.paths.projectCaptureDir, pendingEntries[0]!);

    // prompt.md present
    expect(existsSync(join(pendingDir, 'prompt.md'))).toBe(true);
    const promptContent = readFileSync(join(pendingDir, 'prompt.md'), 'utf8');
    expect(promptContent).toContain('What is the meaning of life?');

    // meta.json present and valid
    const meta = readMeta(pendingDir);
    expect(meta).not.toBeNull();
    expect(meta!.schema_version).toBe(1);
    expect(meta!.project_id).toBe('testproj1234');
    expect(meta!.session_id).toBe(sessionId);
    expect(meta!.started_at).toBeTruthy();
    expect(meta!.finalized_at).toBeNull();

    // Session marker present
    const current = resolveCurrentTurn(ctx.paths.projectStateDir, sessionId);
    expect(current).not.toBeNull();
    expect(current!.turnDir).toBe(pendingDir);
  });

  it('Stop finalizes: response.md, files-changed.txt, meta, rename, session cleared', () => {
    // First: UserPromptSubmit
    const submitEvent: UserPromptSubmitPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: join(projectRoot, 'transcript.jsonl'),
      cwd: projectRoot,
      prompt: 'Tell me about TypeScript',
    };

    // Create a transcript file for the Stop handler to read
    const transcriptContent = [
      JSON.stringify({
        type: 'human',
        message: { content: [{ type: 'text', text: 'Tell me about TypeScript' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'TypeScript is a typed superset of JavaScript.',
            },
          ],
        },
      }),
    ].join('\n');
    writeFileSync(join(projectRoot, 'transcript.jsonl'), transcriptContent);

    handleUserPromptSubmit(submitEvent, ctx);

    // Verify .pending exists
    let entries = readdirSync(ctx.paths.projectCaptureDir);
    expect(entries.filter((e) => e.endsWith('.pending'))).toHaveLength(1);

    // Now: Stop
    const stopEvent: StopPayload = {
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: join(projectRoot, 'transcript.jsonl'),
      cwd: projectRoot,
    };

    handleStop(stopEvent, ctx);

    // .pending dir should be gone
    entries = readdirSync(ctx.paths.projectCaptureDir);
    const pendingEntries = entries.filter((e) => e.endsWith('.pending'));
    expect(pendingEntries).toHaveLength(0);

    // Finalized dir should exist
    const finalizedEntries = entries.filter((e) => !e.endsWith('.pending'));
    expect(finalizedEntries).toHaveLength(1);

    const finalizedDir = join(ctx.paths.projectCaptureDir, finalizedEntries[0]!);

    // response.md present
    expect(existsSync(join(finalizedDir, 'response.md'))).toBe(true);
    const responseContent = readFileSync(join(finalizedDir, 'response.md'), 'utf8');
    expect(responseContent).toContain('TypeScript is a typed superset');

    // files-changed.txt present (empty since not a real git repo)
    expect(existsSync(join(finalizedDir, 'files-changed.txt'))).toBe(true);

    // meta.json finalized
    const meta = readMeta(finalizedDir);
    expect(meta).not.toBeNull();
    expect(meta!.finalized_at).toBeTruthy();
    expect(meta!.finalization_reason).toBe('stop');

    // Session marker cleared
    const current = resolveCurrentTurn(ctx.paths.projectStateDir, sessionId);
    expect(current).toBeNull();
  });

  it('prompt with secret gets scrubbed and hit count is in meta', () => {
    const event: UserPromptSubmitPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: '/tmp/t.jsonl',
      cwd: projectRoot,
      prompt: 'Use this key: sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    };

    handleUserPromptSubmit(event, ctx);

    const entries = readdirSync(ctx.paths.projectCaptureDir);
    const pendingDir = join(ctx.paths.projectCaptureDir, entries[0]!);

    // prompt.md should NOT contain the raw key
    const promptContent = readFileSync(join(pendingDir, 'prompt.md'), 'utf8');
    expect(promptContent).not.toContain('sk-ant-api03');

    // meta should reflect scrubber hits
    const meta = readMeta(pendingDir);
    expect(meta!.scrubber_hit_count).toBeGreaterThanOrEqual(1);
  });

  it('Stop with no pending turn does not throw', () => {
    const stopEvent: StopPayload = {
      hook_event_name: 'Stop',
      session_id: 'non-existent-session',
      transcript_path: '/tmp/t.jsonl',
      cwd: projectRoot,
    };

    // Should not throw — orphan stop is silently handled
    expect(() => handleStop(stopEvent, ctx)).not.toThrow();
  });

  it('file permissions: prompt.md 0600, dirs 0700', () => {
    const event: UserPromptSubmitPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: '/tmp/t.jsonl',
      cwd: projectRoot,
      prompt: 'Check permissions',
    };

    handleUserPromptSubmit(event, ctx);

    const entries = readdirSync(ctx.paths.projectCaptureDir);
    const pendingDir = join(ctx.paths.projectCaptureDir, entries[0]!);

    // Dir is 0700
    const dirStat = statSync(pendingDir);
    if (!isWindows) {
      expect(dirStat.mode & 0o777).toBe(0o700);
    }

    // prompt.md is 0600
    const fileStat = statSync(join(pendingDir, 'prompt.md'));
    if (!isWindows) {
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    // meta.json is 0600
    const metaStat = statSync(join(pendingDir, 'meta.json'));
    if (!isWindows) {
      expect(metaStat.mode & 0o777).toBe(0o600);
    }
  });

  it('readers see zero finalized dirs during .pending phase', () => {
    const event: UserPromptSubmitPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: sessionId,
      transcript_path: '/tmp/t.jsonl',
      cwd: projectRoot,
      prompt: 'test',
    };

    handleUserPromptSubmit(event, ctx);

    // Simulate what a reader should do: filter out .pending
    const entries = readdirSync(ctx.paths.projectCaptureDir);
    const visibleToReaders = entries.filter((e) => !e.endsWith('.pending'));
    expect(visibleToReaders).toHaveLength(0);
  });
});
