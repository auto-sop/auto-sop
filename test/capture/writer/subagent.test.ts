import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  resolveSubagentTurn,
  setSubagentCurrentTurn,
  clearSubagentCurrentTurn,
  linkChildToParent,
} from '~/capture/writer/subagent.js';
import {
  createPendingTurnDir,
  finalizeTurnDir,
  compactIso,
  generateTurnId,
} from '~/capture/writer/turn-dir.js';
import { setCurrentTurn } from '~/capture/writer/session-state.js';
import { startMeta, writeMeta, readMeta, finalizeMeta } from '~/capture/writer/meta.js';
import { writePromptMd } from '~/capture/writer/prompt-response.js';
import {
  appendPreToolLine,
  appendPostToolLine,
  TOOL_CALLS_JSONL,
} from '~/capture/writer/tool-calls.js';
import type { PreToolLine, PostToolLine } from '~/capture/writer/tool-calls.js';
import type { TurnMeta } from '~/capture/types.js';
import type { HookPayloadType } from '~/capture/events.js';
import { createScrubber, type Scrubber } from '~/scrubber/index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claude-sop-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePayload(overrides: Partial<HookPayloadType> = {}): HookPayloadType {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    prompt: 'test prompt',
    ...overrides,
  } as HookPayloadType;
}

/**
 * Create a pending turn dir with valid meta, simulating the main-thread route.
 */
function createTurnWithMeta(
  capturesDir: string,
  stateDir: string,
  opts: {
    sessionId?: string;
    agent?: string;
    subagentType?: string | null;
    parentTurnId?: string | null;
    prompt?: string;
    scrubber: Scrubber;
  },
): { turnDir: string; turnId: string } {
  const turnId = generateTurnId();
  const ts = compactIso();
  const agent = opts.agent ?? 'main';

  const pendingDir = createPendingTurnDir({
    capturesDir,
    ts,
    agent,
    filehash: 'pending',
    turnId,
  });

  const meta = startMeta(makePayload({ session_id: opts.sessionId ?? 'sess-1' }), {
    projectId: 'test-proj-id',
    projectSlug: 'test-proj',
    turnId,
    agent,
    subagentType: opts.subagentType ?? null,
    hookShimVersion: '0.1.0',
  });
  writeMeta(pendingDir, {
    ...meta,
    parent_turn_id: opts.parentTurnId ?? null,
  });

  if (opts.prompt) {
    writePromptMd(pendingDir, opts.prompt, opts.scrubber);
  }

  return { turnDir: pendingDir, turnId };
}

describe('subagent', () => {
  let tmpBase: string;
  let capturesDir: string;
  let stateDir: string;
  let scrubber: Scrubber;

  beforeEach(async () => {
    tmpBase = makeTmpDir();
    capturesDir = join(tmpBase, 'captures');
    stateDir = join(tmpBase, 'state');
    mkdirSync(capturesDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    scrubber = await createScrubber();
  });

  describe('resolveSubagentTurn / setSubagentCurrentTurn / clearSubagentCurrentTurn', () => {
    it('returns null when no marker exists', () => {
      expect(resolveSubagentTurn(stateDir, 'sess-1', 'agent-1')).toBeNull();
    });

    it('round-trips set → resolve', () => {
      const data = { turnDir: '/tmp/test-dir', turnId: 'turn-abc' };
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-1', data);
      const result = resolveSubagentTurn(stateDir, 'sess-1', 'agent-1');
      expect(result).toEqual(data);
    });

    it('clear removes the marker', () => {
      const data = { turnDir: '/tmp/test-dir', turnId: 'turn-abc' };
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-1', data);
      clearSubagentCurrentTurn(stateDir, 'sess-1', 'agent-1');
      expect(resolveSubagentTurn(stateDir, 'sess-1', 'agent-1')).toBeNull();
    });

    it('different agent_ids are independent', () => {
      const data1 = { turnDir: '/tmp/dir-1', turnId: 'turn-1' };
      const data2 = { turnDir: '/tmp/dir-2', turnId: 'turn-2' };
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-1', data1);
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-2', data2);
      expect(resolveSubagentTurn(stateDir, 'sess-1', 'agent-1')).toEqual(data1);
      expect(resolveSubagentTurn(stateDir, 'sess-1', 'agent-2')).toEqual(data2);
    });
  });

  describe('linkChildToParent', () => {
    it('appends child turn_id to parent children_turn_ids', () => {
      const parent = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'main',
        scrubber,
      });
      const childMeta: TurnMeta = {
        schema_version: 1,
        project_id: 'test-proj-id',
        project_slug: 'test-proj',
        session_id: 'sess-1',
        turn_id: 'child-turn-1',
        parent_turn_id: parent.turnId,
        children_turn_ids: [],
        agent: 'Explore',
        subagent_type: 'Explore',
        started_at: new Date().toISOString(),
        finalized_at: new Date().toISOString(),
        finalization_reason: 'subagent_stop',
        hook_shim_version: '0.1.0',
        files_changed_count: 0,
        tool_call_count: 1,
        scrubber_hit_count: 0,
      };

      linkChildToParent(childMeta, parent.turnDir);

      const parentMeta = readMeta(parent.turnDir);
      expect(parentMeta!.children_turn_ids).toContain('child-turn-1');
    });

    it('deduplicates children_turn_ids', () => {
      const parent = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'main',
        scrubber,
      });

      const childMeta = {
        turn_id: 'child-dup',
      } as TurnMeta;

      linkChildToParent(childMeta, parent.turnDir);
      linkChildToParent(childMeta, parent.turnDir);

      const parentMeta = readMeta(parent.turnDir);
      const matches = parentMeta!.children_turn_ids.filter((id) => id === 'child-dup');
      expect(matches).toHaveLength(1);
    });

    it('does nothing when parentTurnDir is null (orphan subagent)', () => {
      const childMeta = { turn_id: 'orphan-child' } as TurnMeta;
      // Should not throw
      linkChildToParent(childMeta, null);
    });
  });

  describe('scenario: parent main turn + subagent turn', () => {
    it('produces linked turn dirs with bidirectional references', () => {
      // 1. Main thread opens a turn
      const mainTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'main',
        prompt: 'Run an explore agent',
        scrubber,
      });
      setCurrentTurn(stateDir, 'sess-1', {
        turnDir: mainTurn.turnDir,
        turnId: mainTurn.turnId,
      });

      // 2. Main thread PreToolUse for Task (no agent_id) — dual representation E3
      const taskPreLine: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-task-1',
        tool: 'Task',
        input: { description: 'Explore codebase', prompt: 'find files' },
        t: new Date().toISOString(),
      };
      appendPreToolLine(mainTurn.turnDir, taskPreLine, scrubber);

      // 3. Subagent opens its own turn
      const childTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'Explore',
        subagentType: 'Explore',
        parentTurnId: mainTurn.turnId,
        prompt: 'find files',
        scrubber,
      });
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-a1', {
        turnDir: childTurn.turnDir,
        turnId: childTurn.turnId,
      });

      // 4. Subagent PreToolUse (Read) → goes to child turn
      const readPreLine: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-read-1',
        tool: 'Read',
        input: { file_path: '/tmp/file.ts' },
        t: new Date().toISOString(),
      };
      appendPreToolLine(childTurn.turnDir, readPreLine, scrubber);

      // 5. Subagent PostToolUse
      const readPostLine: PostToolLine = {
        event: 'post',
        tool_use_id: 'tu-read-1',
        output: 'file content here',
        success: true,
        t: new Date().toISOString(),
      };
      appendPostToolLine(childTurn.turnDir, readPostLine, scrubber);

      // 6. SubagentStop → finalize child, link to parent
      finalizeMeta(childTurn.turnDir, 'subagent_stop');
      const finalizedChildDir = finalizeTurnDir(childTurn.turnDir);
      const childMeta = readMeta(finalizedChildDir)!;
      linkChildToParent(childMeta, mainTurn.turnDir);

      // ── Assertions ──

      // Main turn's .pending dir still exists with tool-calls.jsonl containing Task pre line
      expect(existsSync(mainTurn.turnDir)).toBe(true);
      const mainToolCalls = readFileSync(join(mainTurn.turnDir, TOOL_CALLS_JSONL), 'utf8').trim();
      const mainLines = mainToolCalls.split('\n').map((l) => JSON.parse(l));
      expect(
        mainLines.some((l: Record<string, unknown>) => l.tool === 'Task' && l.event === 'pre'),
      ).toBe(true);

      // Child turn dir (non-.pending after SubagentStop) exists
      expect(existsSync(finalizedChildDir)).toBe(true);
      expect(finalizedChildDir.endsWith('.pending')).toBe(false);

      // Child has its own tool-calls.jsonl with Read pre/post
      const childToolCalls = readFileSync(join(finalizedChildDir, TOOL_CALLS_JSONL), 'utf8').trim();
      const childLines = childToolCalls.split('\n').map((l) => JSON.parse(l));
      expect(
        childLines.some((l: Record<string, unknown>) => l.tool === 'Read' && l.event === 'pre'),
      ).toBe(true);
      expect(childLines.some((l: Record<string, unknown>) => l.event === 'post')).toBe(true);

      // Child meta has parent_turn_id = main's turn_id
      expect(childMeta.parent_turn_id).toBe(mainTurn.turnId);
      expect(childMeta.subagent_type).toBe('Explore');
      expect(childMeta.finalization_reason).toBe('subagent_stop');

      // Main turn's meta.children_turn_ids contains the child's turn_id
      const mainMeta = readMeta(mainTurn.turnDir)!;
      expect(mainMeta.children_turn_ids).toContain(childTurn.turnId);
    });
  });

  describe('scenario: subagent without UserPromptSubmit (lazy create)', () => {
    it('creates a child turn dir on the fly from first PreToolUse with new agent_id', () => {
      // The subagent-route handles lazy creation. Here we test the building blocks:
      // An agent_id that has no marker yet → openSubagentTurn creates one.

      // No prior marker for agent-a2
      expect(resolveSubagentTurn(stateDir, 'sess-1', 'agent-a2')).toBeNull();

      // Simulate lazy create: create turn with marker text
      const lazyTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'general-purpose',
        subagentType: 'general-purpose',
        prompt: '[no UserPromptSubmit observed for this subagent]',
        scrubber,
      });
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-a2', {
        turnDir: lazyTurn.turnDir,
        turnId: lazyTurn.turnId,
      });

      // Now the subagent turn exists
      const resolved = resolveSubagentTurn(stateDir, 'sess-1', 'agent-a2');
      expect(resolved).not.toBeNull();
      expect(resolved!.turnId).toBe(lazyTurn.turnId);

      // prompt.md contains the marker
      const prompt = readFileSync(join(lazyTurn.turnDir, 'prompt.md'), 'utf8');
      expect(prompt).toContain('[no UserPromptSubmit observed for this subagent]');
    });
  });

  describe('scenario: nested subagents (E1 unlimited depth)', () => {
    it('subagent-a1 spawns subagent-a2 with correct parent_turn_id linking', () => {
      // Main turn
      const mainTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'main',
        prompt: 'top-level prompt',
        scrubber,
      });
      setCurrentTurn(stateDir, 'sess-1', {
        turnDir: mainTurn.turnDir,
        turnId: mainTurn.turnId,
      });

      // Subagent a1 (child of main)
      const a1Turn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'Explore',
        subagentType: 'Explore',
        parentTurnId: mainTurn.turnId,
        prompt: 'explore files',
        scrubber,
      });
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-a1', {
        turnDir: a1Turn.turnDir,
        turnId: a1Turn.turnId,
      });

      // Subagent a2 (child of a1 — nested!)
      // For nesting: a2's parent is a1
      const a2Turn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'code-review',
        subagentType: 'code-review',
        parentTurnId: a1Turn.turnId,
        prompt: 'review this code',
        scrubber,
      });
      setSubagentCurrentTurn(stateDir, 'sess-1', 'agent-a2', {
        turnDir: a2Turn.turnDir,
        turnId: a2Turn.turnId,
      });

      // Finalize a2 and link to a1
      finalizeMeta(a2Turn.turnDir, 'subagent_stop');
      const finalizedA2 = finalizeTurnDir(a2Turn.turnDir);
      const a2Meta = readMeta(finalizedA2)!;
      linkChildToParent(a2Meta, a1Turn.turnDir);

      // Finalize a1 and link to main
      finalizeMeta(a1Turn.turnDir, 'subagent_stop');
      const finalizedA1 = finalizeTurnDir(a1Turn.turnDir);
      const a1Meta = readMeta(finalizedA1)!;
      linkChildToParent(a1Meta, mainTurn.turnDir);

      // ── Assertions ──

      // a2's parent_turn_id = a1's turn_id
      expect(a2Meta.parent_turn_id).toBe(a1Turn.turnId);

      // a1's children_turn_ids contains a2
      expect(a1Meta.children_turn_ids).toContain(a2Turn.turnId);

      // a1's parent_turn_id = main's turn_id
      expect(a1Meta.parent_turn_id).toBe(mainTurn.turnId);

      // main's children_turn_ids contains a1
      const mainMeta = readMeta(mainTurn.turnDir)!;
      expect(mainMeta.children_turn_ids).toContain(a1Turn.turnId);

      // Both subagent dirs exist (non-.pending)
      expect(existsSync(finalizedA1)).toBe(true);
      expect(existsSync(finalizedA2)).toBe(true);
      expect(finalizedA1.endsWith('.pending')).toBe(false);
      expect(finalizedA2.endsWith('.pending')).toBe(false);
    });
  });

  describe('scenario: dual representation (E3)', () => {
    it('main turn tool-calls.jsonl has Task pre line and child turn dir also exists', () => {
      // Main turn
      const mainTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'main',
        prompt: 'dispatch a task',
        scrubber,
      });

      // Main thread records the Task tool use
      const taskPre: PreToolLine = {
        event: 'pre',
        tool_use_id: 'tu-task-99',
        tool: 'Task',
        input: { description: 'Search codebase', prompt: 'find bug' },
        t: new Date().toISOString(),
      };
      appendPreToolLine(mainTurn.turnDir, taskPre, scrubber);

      const taskPost: PostToolLine = {
        event: 'post',
        tool_use_id: 'tu-task-99',
        output: 'Agent completed successfully',
        success: true,
        t: new Date().toISOString(),
      };
      appendPostToolLine(mainTurn.turnDir, taskPost, scrubber);

      // Child turn also exists separately
      const childTurn = createTurnWithMeta(capturesDir, stateDir, {
        agent: 'general-purpose',
        subagentType: 'general-purpose',
        parentTurnId: mainTurn.turnId,
        prompt: 'find bug',
        scrubber,
      });

      // ── Dual representation verified ──

      // Main's tool-calls.jsonl has the Task pre/post
      const mainToolCalls = readFileSync(join(mainTurn.turnDir, TOOL_CALLS_JSONL), 'utf8').trim();
      const mainLines = mainToolCalls.split('\n').map((l) => JSON.parse(l));
      expect(mainLines.some((l: Record<string, unknown>) => l.tool === 'Task')).toBe(true);
      expect(mainLines).toHaveLength(2); // pre + post

      // Child turn dir exists with its own prompt.md
      expect(existsSync(childTurn.turnDir)).toBe(true);
      const childPrompt = readFileSync(join(childTurn.turnDir, 'prompt.md'), 'utf8');
      expect(childPrompt).toContain('find bug');

      // Child meta references the parent
      const childMeta = readMeta(childTurn.turnDir)!;
      expect(childMeta.parent_turn_id).toBe(mainTurn.turnId);
    });
  });
});
