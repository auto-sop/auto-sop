import { describe, it, expect } from 'vitest';
import { HookPayload } from '../../src/capture/events.js';

const BASE = {
  session_id: 'sess-abc123',
  transcript_path: '/tmp/transcript.jsonl',
  cwd: '/home/user/project',
};

describe('HookPayload discriminated union', () => {
  it('parses UserPromptSubmit', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Hello world',
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('UserPromptSubmit');
    expect(result.prompt).toBe('Hello world');
  });

  it('parses PreToolUse', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/foo.ts' },
      tool_use_id: 'tu-001',
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('PreToolUse');
    if (result.hook_event_name === 'PreToolUse') {
      expect(result.tool_name).toBe('Read');
      expect(result.tool_use_id).toBe('tu-001');
    }
  });

  it('parses PostToolUse', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/bar.ts', content: '...' },
      tool_response: { success: true },
      tool_use_id: 'tu-002',
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('PostToolUse');
    if (result.hook_event_name === 'PostToolUse') {
      expect(result.tool_response).toEqual({ success: true });
    }
  });

  it('parses Stop', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'Stop',
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('Stop');
  });

  it('parses SubagentStop', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'SubagentStop',
      agent_id: 'agent-xyz',
      agent_type: 'code-review',
      agent_transcript_path: '/tmp/sub-transcript.jsonl',
      last_assistant_message: 'Done reviewing.',
      stop_hook_active: true,
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('SubagentStop');
    if (result.hook_event_name === 'SubagentStop') {
      expect(result.agent_id).toBe('agent-xyz');
      expect(result.agent_type).toBe('code-review');
      expect(result.stop_hook_active).toBe(true);
    }
  });

  it('tolerates unknown fields via passthrough', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'Stop',
      future_field: 'surprise',
      another_new_thing: 42,
    };
    const result = HookPayload.parse(payload);
    expect(result.hook_event_name).toBe('Stop');
    // passthrough preserves unknown fields
    expect((result as Record<string, unknown>)['future_field']).toBe('surprise');
    expect((result as Record<string, unknown>)['another_new_thing']).toBe(42);
  });

  it('rejects payload missing required session_id', () => {
    const payload = {
      // no session_id
      transcript_path: '/tmp/t.jsonl',
      cwd: '/project',
      hook_event_name: 'Stop',
    };
    expect(() => HookPayload.parse(payload)).toThrow();
  });

  it('rejects payload with unknown hook_event_name', () => {
    const payload = {
      ...BASE,
      hook_event_name: 'UnknownEvent',
    };
    expect(() => HookPayload.parse(payload)).toThrow();
  });
});
